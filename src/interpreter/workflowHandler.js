const { loadPlugin } = require("./pluginHandler.js");

function asParamDescriptor(param) {
  if (typeof param === "string") {
    return {
      name: param,
      description: `Value for ${param}`,
      type: "string"
    };
  }

  return {
    name: param.name,
    description: param.description || `Value for ${param.name}`,
    type: param.type || "string"
  };
}

function normalizeWorkflow(workflow) {
  const required = Array.isArray(workflow.required_params)
    ? workflow.required_params.map(asParamDescriptor)
    : [];

  const optional = Array.isArray(workflow.optional_params)
    ? workflow.optional_params.map(asParamDescriptor)
    : [];

  return {
    ...workflow,
    required_params: required,
    optional_params: optional
  };
}

function scoreWorkflowMatch(query, workflow) {
  const input = query.toLowerCase();
  const inputTokens = new Set(input.split(/[^a-z0-9@._-]+/i).filter(Boolean));
  const keywords = Array.isArray(workflow.keywords) ? workflow.keywords : [];

  if (String(workflow?.name || "").toLowerCase().startsWith("send_")) {
    // Strict gating: only explicit send-authoring verbs can start send_* workflows.
    // Do NOT treat generic "message in" as send intent, otherwise queries like
    // "latest message in HMT" are misrouted to send workflows.
    const hasSendVerb = /\b(send|write|compose|draft|text|dm)\b/i.test(input);
    if (!hasSendVerb) {
      return 0;
    }
  }

  let score = 0;
  for (const keyword of keywords) {
    const key = String(keyword).toLowerCase().trim();
    if (!key) continue;

    if (input.includes(key)) {
      score += 3;
      continue;
    }

    const keyTokens = key.split(/[^a-z0-9@._-]+/i).filter(Boolean);
    if (keyTokens.length === 0) continue;

    let hits = 0;
    for (const token of keyTokens) {
      if (inputTokens.has(token)) hits++;
    }

    const ratio = hits / keyTokens.length;
    if (ratio >= 0.66) {
      score += ratio * 2;
    }
  }

  return score;
}

function isExplicitCancelIntent(input) {
  const normalized = String(input || "").trim().toLowerCase();
  if (!normalized) return false;
  return /^(cancel|stop|abort|nevermind|never mind|forget it|drop this|quit workflow|cancel workflow)$/i.test(normalized);
}

function findWorkflowMatch(query, obj) {
  let best = {
    score: 0,
    plugin: null,
    workflow: null
  };

  for (const plugin of obj.plugins) {
    const workflows = Array.isArray(plugin?.data?.workflows) ? plugin.data.workflows : [];

    for (const rawWorkflow of workflows) {
      const workflow = normalizeWorkflow(rawWorkflow);
      const score = scoreWorkflowMatch(query, workflow);

      if (score > best.score) {
        best = {
          score,
          plugin,
          workflow
        };
      }
    }
  }

  return best.score > 0 ? best : null;
}

function getMissingRequired(state) {
  const missing = [];
  for (const req of state.workflow.required_params) {
    const value = state.params[req.name];
    if (value === null || value === undefined || value === "") {
      missing.push(req);
    }
  }
  return missing;
}

function getParamPrompt(param) {
  const label = param.description || `Please provide ${param.name}.`;
  return `${label}`.trim();
}

function mergeExtractedParams(state, extractedValues) {
  if (!extractedValues || typeof extractedValues !== "object") {
    return;
  }

  const allowed = new Set([
    ...state.workflow.required_params.map(p => p.name),
    ...state.workflow.optional_params.map(p => p.name)
  ]);

  for (const [key, value] of Object.entries(extractedValues)) {
    if (!allowed.has(key)) continue;
    if (value === null || value === undefined) continue;

    const normalized = typeof value === "string" ? value.trim() : value;
    if (normalized === "") continue;

    state.params[key] = normalized;
  }
}

function parseJsonObject(raw) {
  try {
    const candidate = String(raw || "");
    const match = candidate.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

function extractGenericSendIntent(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  const normalized = raw
    .replace(/^\s*(?:hey|hi|hello)\s*,?\s*/i, "")
    .replace(/^\s*(?:can\s+you|can\s+u|could\s+you|would\s+you|will\s+you|pls|plz|please|just)\s+/i, "")
    .trim();

  const patterns = [
    /^(?:please\s+|just\s+)?tell\s+(.+?)\s+(?:that\s+)?([\s\S]+)$/i,
    /^(?:please\s+|just\s+)?inform\s+(.+?)\s+(?:that\s+)?([\s\S]+)$/i,
    /^(?:please\s+|just\s+)?notify\s+(.+?)\s+(?:that\s+)?([\s\S]+)$/i,
    /^(?:please\s+|just\s+)?let\s+(.+?)\s+know\s+(?:that\s+)?([\s\S]+)$/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;

    const recipient = String(match[1] || "")
      .trim()
      .replace(/^(?:to\s+)/i, "")
      .replace(/[.!?]+$/g, "");
    const message = String(match[2] || "").trim();
    if (!recipient || !message) continue;

    return { recipient, message };
  }

  return null;
}

function getSendWorkflowCandidates(obj) {
  const out = [];
  for (const plugin of obj?.plugins || []) {
    const workflows = Array.isArray(plugin?.data?.workflows) ? plugin.data.workflows : [];
    for (const rawWorkflow of workflows) {
      const workflow = normalizeWorkflow(rawWorkflow);
      if (!String(workflow?.name || "").toLowerCase().startsWith("send_")) continue;
      out.push({ plugin, workflow });
    }
  }
  return out;
}

function describeSendWorkflowOptions(options) {
  return options
    .map((opt, idx) => `${idx + 1}. ${opt.plugin?.data?.name || opt.workflow?.name}`)
    .join("; ");
}

function chooseWorkflowOption(input, options) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw || !Array.isArray(options) || options.length === 0) return null;

  const numeric = raw.match(/^(?:option\s*)?(\d{1,2})$/i);
  if (numeric) {
    const idx = Number(numeric[1]) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
  }

  for (const option of options) {
    const pluginName = String(option.plugin?.data?.name || "").toLowerCase();
    const workflowName = String(option.workflow?.name || "").toLowerCase();
    if (pluginName && raw.includes(pluginName)) return option;
    if (workflowName && raw.includes(workflowName.replace(/^send_/, "").replace(/_/g, " "))) return option;
  }

  if (/\bwhatsapp|wa\b/i.test(raw)) {
    return options.find(opt => /whatsapp/i.test(String(opt.plugin?.data?.name || "") + " " + String(opt.workflow?.name || ""))) || null;
  }
  if (/\bmail|email|gmail\b/i.test(raw)) {
    return options.find(opt => /gmail|email/i.test(String(opt.plugin?.data?.name || "") + " " + String(opt.workflow?.name || ""))) || null;
  }

  return null;
}

function prefillByIntent(state, sendIntent) {
  if (!state || !sendIntent) return;
  const recipient = String(sendIntent.recipient || "").trim();
  const message = String(sendIntent.message || "").trim();
  if (!recipient || !message) return;

  if (Object.prototype.hasOwnProperty.call(state.params, "recipient")) {
    state.params.recipient = recipient;
  }

  if (Object.prototype.hasOwnProperty.call(state.params, "message")) {
    state.params.message = message;
  }

  if (Object.prototype.hasOwnProperty.call(state.params, "body")) {
    state.params.body = message;
  }
}

function getMissingParamHints(state) {
  return getMissingRequired(state).map(param => ({
    name: param.name,
    description: param.description,
    type: param.type
  }));
}

function isMetaReply(input) {
  const normalized = String(input || "").trim().toLowerCase();
  if (!normalized) return true;

  return /^(i just did|already did|you asked|i said|told you|yes|no|ok|okay|hmm|uh+|um+|yeah+|yep|nope)$/.test(normalized);
}

function emailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function applySingleMissingFallback(state, input, extractedValues) {
  const missing = getMissingRequired(state);
  const hasExtractedAny = extractedValues && Object.values(extractedValues).some(value => {
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return value.trim() !== "";
    return true;
  });
  if (missing.length !== 1 || hasExtractedAny) return;

  const param = missing[0];
  const raw = String(input || "").trim();
  if (!raw || isMetaReply(raw)) return;

  if (param.type === "email") {
    if (!emailLike(raw)) return;
    state.params[param.name] = raw;
    return;
  }

  state.params[param.name] = raw;
}

async function extractParamsWithLLM(input, state, obj) {
  const allParams = [
    ...state.workflow.required_params,
    ...state.workflow.optional_params
  ];

  const schema = allParams.map(param => ({
    name: param.name,
    description: param.description,
    type: param.type
  }));

  const visibleCurrentParams = {};
  for (const param of allParams) {
    if (state.params[param.name] !== undefined) {
      visibleCurrentParams[param.name] = state.params[param.name];
    }
  }

  const missingHints = getMissingParamHints(state);

  const prompt =
`You are a workflow parameter extractor.

Return ONLY valid JSON and nothing else.

Schema:
{
  "intent": "continue" | "cancel",
  "values": {
    "<param_name>": "<value or null>"
  }
}

Rules:
- Extract only parameters from the user's latest message.
- If user asks to cancel/stop/abort, set intent to "cancel".
- Do not invent missing values.
- Keep already known values untouched unless user explicitly gives a replacement.
- If exactly one required parameter is still missing and the user gives free text that fits it, map that text to the missing parameter.

Workflow name: ${state.workflow.name}
Workflow description: ${state.workflow.description || "No description"}
Allowed parameters: ${JSON.stringify(schema)}
Missing required parameters now: ${JSON.stringify(missingHints)}
Current collected params: ${JSON.stringify(visibleCurrentParams)}
Latest user message: ${JSON.stringify(input)}
`;

  const raw = await obj.customQuery(prompt);
  const parsed = parseJsonObject(raw);

  if (!parsed) {
    return {
      intent: "continue",
      values: {}
    };
  }

  return {
    intent: parsed.intent === "cancel" ? "cancel" : "continue",
    values: parsed.values && typeof parsed.values === "object" ? parsed.values : {}
  };
}

function initializeWorkflowState(match) {
  const params = {};
  for (const param of [...match.workflow.required_params, ...match.workflow.optional_params]) {
    params[param.name] = undefined;
  }

  return {
    plugin: match.plugin,
    workflow: match.workflow,
    params,
    startedAt: Date.now()
  };
}

async function executeWorkflow(state, obj, userInputForContext) {
  const pluginInstance = loadPlugin(state.plugin, state.plugin.params);
  const executeMethod = state.workflow.execute;

  if (!executeMethod || typeof pluginInstance[executeMethod] !== "function") {
    throw new Error(`Workflow execute method not found: ${executeMethod}`);
  }

  return await pluginInstance[executeMethod](state.params, {
    input: userInputForContext,
    workflow: state.workflow.name
  });
}

async function applyPluginPrefill(state, obj, input) {
  try {
    const pluginInstance = loadPlugin(state.plugin, state.plugin.params);
    if (typeof pluginInstance.prefillWorkflowParams !== "function") {
      return;
    }

    const maybeValues = await pluginInstance.prefillWorkflowParams({
      workflow: state.workflow.name,
      input,
      params: { ...state.params }
    });

    if (!maybeValues || typeof maybeValues !== "object") {
      return;
    }

    mergeExtractedParams(state, maybeValues);
  } catch (_) {
    // ignore for now
  }
}

function stringifyResult(result) {
  if (typeof result === "string") return result;
  if (result === null || result === undefined) return "Workflow completed.";
  if (typeof result?.message === "string") return result.message;
  return JSON.stringify(result);
}

function handleExecutionResult(state, obj, workflowResult) {
  if (workflowResult && typeof workflowResult === "object" && workflowResult.status === "needs_input") {
    const field = workflowResult.field;
    if (field && Object.prototype.hasOwnProperty.call(state.params, field)) {
      delete state.params[field];
    }

    return {
      handled: true,
      response: stringifyResult(workflowResult)
    };
  }

  obj.workflowState = null;
  return {
    handled: true,
    response: stringifyResult(workflowResult)
  };
}

async function continueActiveWorkflow(input, obj) {
  const state = obj.workflowState;
  const extracted = await extractParamsWithLLM(input, state, obj);

  if (extracted.intent === "cancel" && isExplicitCancelIntent(input)) {
    obj.workflowState = null;
    return {
      handled: true,
      response: "Okay, I cancelled that workflow."
    };
  }

  mergeExtractedParams(state, extracted.values);
  applySingleMissingFallback(state, input, extracted.values);
  await applyPluginPrefill(state, obj, input);

  const missing = getMissingRequired(state);
  if (missing.length > 0) {
    return {
      handled: true,
      response: getParamPrompt(missing[0])
    };
  }

  const workflowResult = await executeWorkflow(state, obj, input);
  return handleExecutionResult(state, obj, workflowResult);
}

async function startNewWorkflow(match, input, obj) {
  const state = initializeWorkflowState(match);
  obj.workflowState = state;

  const extracted = await extractParamsWithLLM(input, state, obj);
  if (extracted.intent === "cancel" && isExplicitCancelIntent(input)) {
    obj.workflowState = null;
    return {
      handled: true,
      response: "Okay, I cancelled that workflow."
    };
  }

  mergeExtractedParams(state, extracted.values);
  applySingleMissingFallback(state, input, extracted.values);
  await applyPluginPrefill(state, obj, input);

  const missing = getMissingRequired(state);
  if (missing.length > 0) {
    return {
      handled: true,
      response: getParamPrompt(missing[0])
    };
  }

  const workflowResult = await executeWorkflow(state, obj, input);
  return handleExecutionResult(state, obj, workflowResult);
}

async function handleWorkflowInput(input, obj) {
  if (!obj || !Array.isArray(obj.plugins)) {
    return { handled: false };
  }

  if (obj.workflowState && obj.workflowState.type === "workflow_channel_selection") {
    const state = obj.workflowState;

    if (isExplicitCancelIntent(input)) {
      obj.workflowState = null;
      return {
        handled: true,
        response: "Okay, I cancelled that workflow."
      };
    }

    const selected = chooseWorkflowOption(input, state.options || []);
    if (!selected) {
      return {
        handled: true,
        response: `Please choose how to send it: ${describeSendWorkflowOptions(state.options || [])}`
      };
    }

    const concrete = initializeWorkflowState({ plugin: selected.plugin, workflow: selected.workflow });
    prefillByIntent(concrete, state.sendIntent);
    obj.workflowState = concrete;

    const missing = getMissingRequired(concrete);
    if (missing.length > 0) {
      return {
        handled: true,
        response: getParamPrompt(missing[0])
      };
    }

    const workflowResult = await executeWorkflow(concrete, obj, input);
    return handleExecutionResult(concrete, obj, workflowResult);
  }

  if (obj.workflowState) {
    const activeState = obj.workflowState;
    const activeScore = scoreWorkflowMatch(input, activeState.workflow);
    const incomingMatch = findWorkflowMatch(input, obj);

    const shouldSwitchWorkflow =
      incomingMatch &&
      incomingMatch.workflow &&
      incomingMatch.workflow.name !== activeState.workflow.name &&
      incomingMatch.score >= Math.max(3, activeScore + 1);

    if (shouldSwitchWorkflow) {
      obj.workflowState = null;
      return await startNewWorkflow(incomingMatch, input, obj);
    }

    return await continueActiveWorkflow(input, obj);
  }

  const match = findWorkflowMatch(input, obj);
  if (!match) {
    const sendIntent = extractGenericSendIntent(input);
    if (!sendIntent) {
      return { handled: false };
    }

    const sendOptions = getSendWorkflowCandidates(obj);
    if (sendOptions.length === 0) {
      return { handled: false };
    }

    if (sendOptions.length === 1) {
      const single = initializeWorkflowState({ plugin: sendOptions[0].plugin, workflow: sendOptions[0].workflow });
      prefillByIntent(single, sendIntent);
      obj.workflowState = single;

      const missing = getMissingRequired(single);
      if (missing.length > 0) {
        return {
          handled: true,
          response: getParamPrompt(missing[0])
        };
      }

      const workflowResult = await executeWorkflow(single, obj, input);
      return handleExecutionResult(single, obj, workflowResult);
    }

    obj.workflowState = {
      type: "workflow_channel_selection",
      startedAt: Date.now(),
      sendIntent,
      options: sendOptions
    };

    return {
      handled: true,
      response: `How would you like to send this message? ${describeSendWorkflowOptions(sendOptions)}`
    };
  }

  return await startNewWorkflow(match, input, obj);
}

module.exports = {
  handleWorkflowInput
};
