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
  const keywords = Array.isArray(workflow.keywords) ? workflow.keywords : [];

  let score = 0;
  for (const keyword of keywords) {
    if (input.includes(String(keyword).toLowerCase())) {
      score++;
    }
  }

  return score;
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
  const hasExtractedAny = extractedValues && Object.keys(extractedValues).length > 0;
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
Current collected params: ${JSON.stringify(state.params)}
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
  return {
    plugin: match.plugin,
    workflow: match.workflow,
    params: {},
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

async function continueActiveWorkflow(input, obj) {
  const state = obj.workflowState;
  const extracted = await extractParamsWithLLM(input, state, obj);

  if (extracted.intent === "cancel") {
    obj.workflowState = null;
    return {
      handled: true,
      response: "Okay, I cancelled that workflow."
    };
  }

  mergeExtractedParams(state, extracted.values);
  applySingleMissingFallback(state, input, extracted.values);

  const missing = getMissingRequired(state);
  if (missing.length > 0) {
    return {
      handled: true,
      response: getParamPrompt(missing[0])
    };
  }

  const workflowResult = await executeWorkflow(state, obj, input);
  obj.workflowState = null;

  return {
    handled: true,
    response: typeof workflowResult === "string"
      ? workflowResult
      : JSON.stringify(workflowResult)
  };
}

async function startNewWorkflow(match, input, obj) {
  const state = initializeWorkflowState(match);
  obj.workflowState = state;

  const extracted = await extractParamsWithLLM(input, state, obj);
  if (extracted.intent === "cancel") {
    obj.workflowState = null;
    return {
      handled: true,
      response: "Okay, I cancelled that workflow."
    };
  }

  mergeExtractedParams(state, extracted.values);
  applySingleMissingFallback(state, input, extracted.values);

  const missing = getMissingRequired(state);
  if (missing.length > 0) {
    return {
      handled: true,
      response: getParamPrompt(missing[0])
    };
  }

  const workflowResult = await executeWorkflow(state, obj, input);
  obj.workflowState = null;

  return {
    handled: true,
    response: typeof workflowResult === "string"
      ? workflowResult
      : JSON.stringify(workflowResult)
  };
}

async function handleWorkflowInput(input, obj) {
  if (!obj || !Array.isArray(obj.plugins)) {
    return { handled: false };
  }

  if (obj.workflowState) {
    return await continueActiveWorkflow(input, obj);
  }

  const match = findWorkflowMatch(input, obj);
  if (!match) {
    return { handled: false };
  }

  return await startNewWorkflow(match, input, obj);
}

module.exports = {
  handleWorkflowInput
};
