const R = require('./response.js');
const { loadPlugin } = require("./pluginHandler.js");
const { answer, answerSmall } = require("./groq.js");

// ─── Normalization (unchanged, just data prep) ───────────────────────────────

function asParamDescriptor(param) {
  if (typeof param === "string") {
    return { name: param, description: `Value for ${param}`, type: "string" };
  }
  return {
    name: param.name,
    description: param.description || `Value for ${param.name}`,
    type: param.type || "string"
  };
}

function normalizeWorkflow(workflow) {
  return {
    ...workflow,
    required_params: Array.isArray(workflow.required_params)
      ? workflow.required_params.map(asParamDescriptor)
      : [],
    optional_params: Array.isArray(workflow.optional_params)
      ? workflow.optional_params.map(asParamDescriptor)
      : []
  };
}

// ─── Build the workflow catalogue for the AI ─────────────────────────────────

function buildWorkflowCatalogue(plugins) {
  const catalogue = [];

  for (const plugin of plugins) {
    const workflows = Array.isArray(plugin?.data?.workflows)
      ? plugin.data.workflows
      : [];

    for (const raw of workflows) {
      const wf = normalizeWorkflow(raw);
      catalogue.push({
        plugin_name: plugin?.data?.name || plugin?.name || "unknown",
        workflow_name: wf.name,
        description: wf.description || "",
        required_params: wf.required_params,
        optional_params: wf.optional_params
      });
    }
  }

  return catalogue;
}

// ─── Stringify helpers ────────────────────────────────────────────────────────

function stringifyResult(result) {
  if (typeof result === "string") return result;
  if (result === null || result === undefined) return "Done!";
  if (typeof result?.message === "string") return result.message;
  return JSON.stringify(result);
}

function parseJsonObject(raw) {
  try {
    const match = String(raw || "").match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

// ─── Core AI call ─────────────────────────────────────────────────────────────
//
// Everything flows through here. The AI receives full context and returns a
// single structured decision. No regex, no keyword scoring — the model decides.

async function callWorkflowAI(systemPrompt, userMessage, obj) {
  const raw = await obj.customQuery(`${systemPrompt}\n\nUser: ${userMessage}`);
  
  const parsed = parseJsonObject(raw);
  if (process.env.BTW_WORKFLOW_DEBUG === "1") {
    console.debug("[workflow:ai] raw →", raw?.slice?.(0, 300));
    console.debug("[workflow:ai] parsed →", JSON.stringify(parsed));
  }
  return parsed;
}

function buildSystemPrompt(catalogue, activeState) {
  const catalogueText = JSON.stringify(catalogue, null, 2);

  const activeBlock = activeState
    ? `
## Active Workflow
You are currently mid-way through a workflow. Here is the state:
- Workflow: ${activeState.workflow.name}
- Plugin: ${activeState.plugin?.data?.name || "unknown"}
- Collected params so far: ${JSON.stringify(activeState.params, null, 2)}
- Still missing (required): ${JSON.stringify(getMissingRequired(activeState).map(p => p.name))}
`
    : `## No workflow is currently active.`;

  return `
You are BTW, a friendly and conversational voice assistant. Your job is to understand what the user wants to do and help them through it naturally — like a helpful friend, not a form.

${activeBlock}

## Available Workflows
${catalogueText}

## Your task
Analyze the user's message and return a JSON object with ONE of the following actions:

### If the user wants to START a new workflow:
{
  "action": "start",
  "plugin_name": "<plugin name>",
  "workflow_name": "<workflow name>",
  "values": { "<param>": "<value or null>" },
  "message": "<optional friendly acknowledgement, or null>"
}

### If a workflow is active and the user is PROVIDING info / continuing:
{
  "action": "continue",
  "values": { "<param>": "<extracted value or null>" },
  "message": null
}

### If you need more information from the user (ask naturally, not like a form):
{
  "action": "ask",
  "values": { "<param>": "<any values you DID extract from this message, or omit>" },
  "message": "<your friendly question>"
}

### If the user wants to CANCEL the current workflow:
{
  "action": "cancel",
  "message": "Sure, I've cancelled that. What else can I help you with?"
}

### If the user wants to EXECUTE (all params are collected):
{
  "action": "execute",
  "values": { "<param>": "<any final values extracted from this message, or omit>" },
  "message": null
}

### If the message is not related to any workflow at all:
{
  "action": "none",
  "message": null
}

## Rules
- Be warm and conversational. When asking for missing info, phrase it naturally ("Who should I send this to?" not "Please provide recipient").
- Extract as many param values from the user's message as possible in one pass.
- If only one param is missing and the user's message clearly contains it, map it directly without asking again.
- If the user says things like "idk", "help me write", "suggest something" — offer 2 short draft options in your "ask" message and tell them to pick one or edit it.
- Never expose internal workflow names or param names to the user. Talk like a person.
- If you're unsure whether the user wants a workflow or just chatting, return "none".
- CRITICAL: When the user confirms or says "send it", "go ahead", "do it", "yes", "perfect" and all params are collected — return "execute". NEVER narrate the action with a "text" response. The system will handle sending; your job is only to return the JSON.
- CRITICAL: When the user picks a draft option and edits it (e.g. "option 1 but change X to Y"), extract the final edited param values into "values" and return action "continue" or "ask" for the next missing param. Do NOT lose those values.
- Return ONLY the JSON object. No preamble, no markdown fences.
`.trim();
}

// ─── State helpers ────────────────────────────────────────────────────────────

function getMissingRequired(state) {
  return state.workflow.required_params.filter(req => {
    const v = state.params[req.name];
    return v === null || v === undefined || v === "";
  });
}

function initializeWorkflowState(plugin, workflow) {
  const params = {};
  for (const p of [...workflow.required_params, ...workflow.optional_params]) {
    params[p.name] = undefined;
  }
  return { plugin, workflow, params, startedAt: Date.now() };
}

function mergeValues(state, values) {
  if (!values || typeof values !== "object") return;

  const allowed = new Set([
    ...state.workflow.required_params.map(p => p.name),
    ...state.workflow.optional_params.map(p => p.name)
  ]);

  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key)) continue;
    if (value === null || value === undefined) continue;
    const normalized = typeof value === "string" ? value.trim() : value;
    if (normalized === "") continue;
    state.params[key] = normalized;
  }
}

async function applyPluginPrefill(state, obj, input) {
  try {
    const instance = loadPlugin(state.plugin, state.plugin.params);
    if (typeof instance.prefillWorkflowParams !== "function") return;
    const maybeValues = await instance.prefillWorkflowParams({
      workflow: state.workflow.name,
      input,
      params: { ...state.params }
    });
    if (maybeValues && typeof maybeValues === "object") {
      mergeValues(state, maybeValues);
    }
  } catch (_) {
    // silently ignore prefill errors
  }
}

async function executeWorkflow(state, obj, input) {
  const instance = loadPlugin(state.plugin, state.plugin.params);
  const method = state.workflow.execute;
  if (!method || typeof instance[method] !== "function") {
    throw new Error(`Workflow execute method not found: ${method}`);
  }
  return await instance[method](state.params, { input, workflow: state.workflow.name });
}

function handleExecutionResult(state, obj, result) {
  // Plugin may signal it needs more input (e.g. disambiguation)
  if (result && typeof result === "object" && result.status === "needs_input") {
    const field = result.field;
    if (field && Object.prototype.hasOwnProperty.call(state.params, field)) {
      delete state.params[field];
    }
    return { handled: true, response: R.ask(stringifyResult(result), result.options || []) };
  }

  obj.workflowState = null;
  return { handled: true, response: stringifyResult(result) };
}

// ─── Find plugin + workflow by name ──────────────────────────────────────────

function findPluginAndWorkflow(obj, pluginName, workflowName) {
  for (const plugin of obj.plugins) {
    const workflows = Array.isArray(plugin?.data?.workflows) ? plugin.data.workflows : [];
    for (const raw of workflows) {
      const wf = normalizeWorkflow(raw);
      if (wf.name === workflowName) {
        // loose plugin name match so the AI doesn't need to be pixel-perfect
        const pName = String(plugin?.data?.name || plugin?.name || "").toLowerCase();
        if (!pluginName || pName.includes(pluginName.toLowerCase()) || pluginName.toLowerCase().includes(pName)) {
          return { plugin, workflow: wf };
        }
        // fallback: if workflow name uniquely identifies it, accept anyway
        return { plugin, workflow: wf };
      }
    }
  }
  return null;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function handleWorkflowInput(input, obj) {
  if (!obj || !Array.isArray(obj.plugins)) return { handled: false };

  const catalogue = buildWorkflowCatalogue(obj.plugins);
  if (catalogue.length === 0) return { handled: false };

  const activeState = obj.workflowState || null;
  const systemPrompt = buildSystemPrompt(catalogue, activeState);

  let decision;
  try {
    decision = await callWorkflowAI(systemPrompt, input, obj);
  } catch (err) {
    // If AI fails, fall through so BTW's normal response path handles it
    return { handled: false };
  }

  if (!decision || !decision.action) return { handled: false };

  // ── CANCEL ────────────────────────────────────────────────────────────────
  if (decision.action === "cancel") {
    obj.workflowState = null;
    return {
      handled: true,
      response: decision.message || "No problem, cancelled that."
    };
  }

  // ── NONE (not a workflow query) ───────────────────────────────────────────
  if (decision.action === "none") {
    return { handled: false };
  }

  // ── ASK (AI needs more info / wants to clarify) ───────────────────────────
  if (decision.action === "ask") {
    // Commit any param values the AI extracted alongside the question.
    // This is critical for the draft-selection flow: the AI confirms chosen
    // subject/body text AND asks a follow-up, but the values must be stored
    // or they'll be lost when the next message comes in.
    if (activeState && decision.values && typeof decision.values === "object") {
      mergeValues(activeState, decision.values);
    }
    return {
      handled: true,
      response: decision.message || "Can you give me a bit more detail?"
    };
  }

  // ── START (new workflow detected) ─────────────────────────────────────────
  if (decision.action === "start") {
    const found = findPluginAndWorkflow(obj, decision.plugin_name, decision.workflow_name);
    if (!found) return { handled: false }; // AI hallucinated a workflow that doesn't exist

    const state = initializeWorkflowState(found.plugin, found.workflow);
    obj.workflowState = state;

    mergeValues(state, decision.values);
    await applyPluginPrefill(state, obj, input);

    const missing = getMissingRequired(state);
    if (missing.length > 0) {
      // Re-ask AI for a friendly question about the first missing param
      const askPrompt = buildSystemPrompt(catalogue, state);
      const askDecision = await callWorkflowAI(
        askPrompt,
        `The workflow started. Ask the user for: ${missing[0].name} (${missing[0].description})`,
        obj
      );
      const msg = askDecision?.message || `What's the ${missing[0].name}?`;
      return { handled: true, response: msg };
    }

    const result = await executeWorkflow(state, obj, input);
    return handleExecutionResult(state, obj, result);
  }

  // ── CONTINUE (active workflow, user gave more info) ───────────────────────
  if (decision.action === "continue") {
    if (!activeState) {
      // State was unexpectedly cleared (e.g. after a plugin needs_input round).
      // Nothing we can do without a state object — fall through.
      return { handled: false };
    }

    mergeValues(activeState, decision.values);
    await applyPluginPrefill(activeState, obj, input);

    const missing = getMissingRequired(activeState);
    if (missing.length > 0) {
      const askPrompt = buildSystemPrompt(catalogue, activeState);
      const askDecision = await callWorkflowAI(
        askPrompt,
        `Still missing: ${missing[0].name} (${missing[0].description}). Ask the user for it.`,
        obj
      );
      const msg = askDecision?.message || `Just need one more thing — ${missing[0].description}`;
      return { handled: true, response: msg };
    }

    const result = await executeWorkflow(activeState, obj, input);
    return handleExecutionResult(activeState, obj, result);
  }

  // ── EXECUTE (AI says all params are ready) ────────────────────────────────
  if (decision.action === "execute") {
    if (!activeState) {
      return { handled: false };
    }

    // Merge any last-minute values the AI included with the execute decision
    if (decision.values && typeof decision.values === "object") {
      mergeValues(activeState, decision.values);
    }

    await applyPluginPrefill(activeState, obj, input);

    const missing = getMissingRequired(activeState);
    if (missing.length > 0) {
      // Safety net — AI said execute but params aren't actually all there yet
      const askPrompt = buildSystemPrompt(catalogue, activeState);
      const askDecision = await callWorkflowAI(
        askPrompt,
        `Still missing: ${missing[0].name} (${missing[0].description}). Ask the user for it.`,
        obj
      );
      const msg = askDecision?.message || `Just need one more thing — ${missing[0].description}`;
      return { handled: true, response: msg };
    }

    const result = await executeWorkflow(activeState, obj, input);
    return handleExecutionResult(activeState, obj, result);
  }

  return { handled: false };
}

module.exports = { handleWorkflowInput };