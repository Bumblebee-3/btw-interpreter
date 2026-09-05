const R = require('./response.js');
const { loadPlugin } = require("./pluginHandler.js");

// ─── Normalization ────────────────────────────────────────────────────────────

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

async function callWorkflowAI(systemPrompt, userMessage, obj) {
  const raw = await obj.customQuery(`${systemPrompt}\n\nUser: ${userMessage}`, "openai/gpt-oss-20b");

  const parsed = parseJsonObject(raw);
  if (process.env.BTW_WORKFLOW_DEBUG === "1") {
    console.debug("[workflow:ai] raw →", raw?.slice?.(0, 300));
    console.debug("[workflow:ai] parsed →", JSON.stringify(parsed));
  }
  return parsed;
}

function buildSystemPrompt(catalogue, activeState) {
  const catalogueText = JSON.stringify(catalogue, null, 2);

  // Build a human-readable summary of collected params so the AI understands
  // what has already been confirmed — critical for draft selection flows.
  let collectedSummary = "";
  if (activeState) {
    const collected = Object.entries(activeState.params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `  - ${k}: ${JSON.stringify(v)}`)
      .join("\n");
    collectedSummary = collected
      ? `\nAlready confirmed values:\n${collected}`
      : "\nNo values confirmed yet.";
  }

  // FIX 1: When a workflow is active, make it crystal-clear to the AI that
  // vague/conversational messages are CONTINUATION turns, never "none".
  // Also expose the pending drafts if any, so the AI can resolve them.
  const pendingDrafts = activeState?.pendingDrafts
    ? `\nPending draft options offered to the user:\n${JSON.stringify(activeState.pendingDrafts, null, 2)}\nIf the user picks one (by number, "first option", "option 2", etc.) extract the corresponding values.`
    : "";

  const activeBlock = activeState
    ? `
## Active Workflow — YOU ARE MID-CONVERSATION
A workflow is in progress. EVERY user message must be treated as a continuation of this
workflow unless the user explicitly says "cancel", "stop", or "never mind".
Do NOT return "none" when a workflow is active.

- Workflow : ${activeState.workflow.name}
- Plugin   : ${activeState.plugin?.data?.name || "unknown"}
- Still missing (required): ${JSON.stringify(getMissingRequired(activeState).map(p => p.name))}
${collectedSummary}
${pendingDrafts}
`
    : `## No workflow is currently active.`;

  return `
You are BTW, a friendly and conversational voice assistant. Your job is to understand what the user wants to do and help them through it naturally — like a helpful friend, not a form.

${activeBlock}

## Available Workflows
${catalogueText}

## Your task
Analyze the user's message and return a JSON object with ONE of the following actions:

### If NO workflow is active and the user wants to START a new one:
{
  "action": "start",
  "plugin_name": "<plugin name>",
  "workflow_name": "<workflow name>",
  "values": { "<param>": "<value or null>" },
  "message": "<optional friendly acknowledgement, or null>"
}

### If a workflow IS active and the user is PROVIDING info / selecting a draft / continuing:
{
  "action": "continue",
  "values": { "<param>": "<extracted value>" },
  "message": null
}

### If you need to ask the user for more info (ask naturally):
{
  "action": "ask",
  "values": { "<param>": "<any values you DID extract from this message>" },
  "message": "<your friendly question or draft options>",
  "drafts": { "<param_name>": ["<option 1 text>", "<option 2 text>"] }
}
(Include "drafts" only when you offer multiple options for a param so the system can store them.)

### If the user wants to CANCEL the current workflow:
{
  "action": "cancel",
  "message": "Sure, I've cancelled that. What else can I help you with?"
}

### If a workflow IS active and ALL required params are now collected:
{
  "action": "execute",
  "values": { "<param>": "<any final values extracted from this message>" },
  "message": null
}

### If NO workflow is active and the message is unrelated to any workflow:
{
  "action": "none",
  "message": null
}

## Rules
- CRITICAL: If a workflow is active, NEVER return "none". Return "continue", "ask", or "execute".
- Be warm and conversational. When asking for missing info, phrase it naturally.
- Extract as many param values as possible in one pass.
- When the user picks a numbered draft option (e.g. "first option", "option 2", "1"), look up
  the corresponding text from the pendingDrafts block above and emit it as the param value.
- If the user says things like "idk", "help me write", "suggest something" — offer 2 short
  draft options in your "ask" message and populate the "drafts" field with the options keyed
  by param name so they can be stored.
- Never expose internal workflow names or param names to the user.
- When the user confirms (inputs like, but not limited to "send it", "go ahead", "yes", "perfect") and all params are
  collected — return "execute". Never narrate the action.
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
  return { plugin, workflow, params, startedAt: Date.now(), pendingDrafts: null };
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

// FIX 2: Resolve a draft option selection from user input.
// Returns a values object if a selection was made, or null.
function resolveDraftSelection(input, pendingDrafts) {
  if (!pendingDrafts || typeof pendingDrafts !== "object") return null;

  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;

  // Map words/numbers → 0-based index
  const ordinalMap = {
    "1": 0, "one": 0, "first": 0, "option 1": 0, "option one": 0, "option1": 0,
    "2": 1, "two": 1, "second": 1, "option 2": 1, "option two": 1, "option2": 1,
    "3": 2, "three": 2, "third": 2, "option 3": 2, "option three": 2, "option3": 2,
    "4": 3, "four": 3, "fourth": 3, "option 4": 3, "option four": 3, "option4": 3,
    "5": 4, "five": 4, "fifth": 4, "option 5": 4, "option five": 4, "option5": 4,
  };

  // Try to find a matching index
  let idx = null;
  for (const [key, val] of Object.entries(ordinalMap)) {
    if (raw === key || raw.startsWith(key + " ") || raw.startsWith(key + ",") || raw.startsWith(key + ".")) {
      idx = val;
      break;
    }
  }
  // Also try bare digits at start of string
  if (idx === null) {
    const digitMatch = raw.match(/^(\d+)/);
    if (digitMatch) idx = parseInt(digitMatch[1], 10) - 1;
  }

  if (idx === null) return null;

  const resolved = {};
  let anyResolved = false;
  for (const [paramName, options] of Object.entries(pendingDrafts)) {
    if (Array.isArray(options) && idx < options.length) {
      resolved[paramName] = options[idx];
      anyResolved = true;
    }
  }

  return anyResolved ? resolved : null;
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

// applyPluginResolveParams: called after every prefill + merge cycle.
// Gives plugins a chance to asynchronously resolve param values (e.g. look up
// a contact by name) before the workflow handler decides what to ask the user.
//
// Return values from plugin.resolveParams:
//   { resolved: { paramName: value } }         → auto-fill and continue
//   { needs_input: true, field, message,        → surface to user; clears the
//     candidates? }                               bad field so it stays missing
//   {} or undefined                             → nothing to do
//
// Returns: { ok: true } if all good, or { ok: false, field, message, candidates? }
async function applyPluginResolveParams(state, obj) {
  try {
    const instance = loadPlugin(state.plugin, state.plugin.params);
    if (typeof instance.resolveParams !== "function") return { ok: true };

    const result = await instance.resolveParams({
      workflow: state.workflow.name,
      params: { ...state.params }
    });

    if (!result || typeof result !== "object") return { ok: true };

    // Plugin resolved one or more values automatically
    if (result.resolved && typeof result.resolved === "object") {
      mergeValues(state, result.resolved);
    }

    // Plugin needs user input (disambiguation, missing contact, etc.)
    if (result.needs_input) {
      const field = result.field;
      // Clear the unresolvable value so it stays in getMissingRequired
      if (field && Object.prototype.hasOwnProperty.call(state.params, field)) {
        state.params[field] = undefined;
      }
      // Store candidates for the Gmail recipient-picker flow
      if (Array.isArray(result.candidates) && result.candidates.length > 0) {
        state.params._recipientCandidates = result.candidates;
      }
      return { ok: false, field, message: result.message, candidates: result.candidates };
    }

    return { ok: true };
  } catch (err) {
    // resolveParams errors are non-fatal; don't crash the workflow
    if (process.env.BTW_WORKFLOW_DEBUG === "1") {
      console.warn("[workflow:resolveParams] error:", err.message);
    }
    return { ok: true };
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
        const pName = String(plugin?.data?.name || plugin?.name || "").toLowerCase();
        if (!pluginName || pName.includes(pluginName.toLowerCase()) || pluginName.toLowerCase().includes(pName)) {
          return { plugin, workflow: wf };
        }
        return { plugin, workflow: wf };
      }
    }
  }
  return null;
}

// ─── Combined prefill + resolve helper ───────────────────────────────────────
// Runs prefillWorkflowParams then resolveParams. If resolve signals needs_input,
// returns { earlyReturn: { handled: true, response: message } } so callers can
// short-circuit immediately. Otherwise returns { earlyReturn: null }.

async function prefillAndResolve(state, obj, input, catalogue) {
  await applyPluginPrefill(state, obj, input);
  const resolved = await applyPluginResolveParams(state, obj);
  if (!resolved.ok) {
    // Plugin needs the user to pick/provide something before we can continue
    return {
      earlyReturn: { handled: true, response: resolved.message }
    };
  }
  return { earlyReturn: null };
}

// ─── Detect whether the user is asking for suggestions ───────────────────────

function isSuggestSignal(text) {
  const t = String(text || "").toLowerCase().trim();
  return (
    t === "idk" || t === "idk man" || t === "dunno" || t === "no idea" ||
    /\b(suggest|suggestion|recommend|idea|ideas|help me|don.?t know|not sure|anything|whatever|you choose|your choice|pick one|you pick)\b/.test(t)
  );
}

// ─── Focused draft generator ──────────────────────────────────────────────────
// Called when the main AI announces options but doesn't include them.
// Makes one targeted call whose only job is to produce 2 concrete options.

async function generateDrafts(state, obj, missingParam) {
  const collectedContext = Object.entries(state.params)
    .filter(([k, v]) => v !== undefined && v !== null && v !== "" && !k.startsWith("_"))
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join("\n") || "  (none yet)";

  const lines = [
    `You are helping a user compose something. Generate exactly 2 short concrete options for the "${missingParam.name}" field.`,
    ``,
    `Workflow context (already collected):`,
    collectedContext,
    ``,
    `Field needed: ${missingParam.name} — ${missingParam.description}`,
    ``,
    `Return ONLY valid JSON, no markdown, no explanation:`,
    `{`,
    `  "option1": "<complete usable text for option 1>",`,
    `  "option2": "<complete usable text for option 2>",`,
    `  "message": "Here are two options — pick one or tell me what to change: 1. <option1 text>  2. <option2 text>"`,
    `}`,
    ``,
    `Rules:`,
    `- Each option must be a complete usable value, NOT a description of a value`,
    `- The message must literally contain both option texts so the user can read and pick`,
    `- Options should be distinct from each other`,
  ];

  try {
    const raw = await obj.customQuery(lines.join("\n"), "openai/gpt-oss-20b");
    const parsed = parseJsonObject(raw);
    if (parsed?.option1 && parsed?.option2) {
      const msg = parsed.message ||
        `Here are two options — pick one or tell me what to change:\n1. ${parsed.option1}\n2. ${parsed.option2}`;
      return { message: msg, drafts: { [missingParam.name]: [parsed.option1, parsed.option2] } };
    }
  } catch (_) { /* fall through */ }

  return null;
}

// ─── Ask a follow-up question for a missing param ────────────────────────────

async function askForMissingParam(catalogue, state, obj, missingParam, userInput) {
  const userSaid = String(userInput || "").trim();
  const wantsSuggestions = isSuggestSignal(userSaid);

  // Fast path: user clearly wants suggestions — skip the routing AI and go
  // straight to the focused generator, which always returns real content.
  if (wantsSuggestions) {
    const drafts = await generateDrafts(state, obj, missingParam);
    if (drafts) {
      state.pendingDrafts = drafts.drafts;
      return drafts.message;
    }
  }

  // Normal path: ask the routing AI.
  const askPrompt = buildSystemPrompt(catalogue, state);
  const syntheticMsg = userSaid
    ? `User said: "${userSaid}"\nStill need: ${missingParam.name} (${missingParam.description}). ` +
      `Respond with action "ask". If offering draft options you MUST include both option texts ` +
      `literally inside "message" AND set drafts:{"${missingParam.name}":["text1","text2"]}.`
    : `The workflow is in progress. Ask the user naturally for: ${missingParam.name} — ${missingParam.description}`;

  const askDecision = await callWorkflowAI(askPrompt, syntheticMsg, obj);

  // Detect "announced options but didn't populate drafts" pattern.
  const hasDraftsField = !!(askDecision?.drafts && typeof askDecision.drafts === "object" &&
    Object.keys(askDecision.drafts).length > 0);
  const messageSuggestsOptions = /\b(option|idea|suggestion|draft|here are|choose|pick)\b/i.test(
    String(askDecision?.message || "")
  );

  if (messageSuggestsOptions && !hasDraftsField) {
    // AI announced options but didn't generate them — use focused generator as fallback.
    const drafts = await generateDrafts(state, obj, missingParam);
    if (drafts) {
      state.pendingDrafts = drafts.drafts;
      return drafts.message;
    }
  }

  if (hasDraftsField) {
    state.pendingDrafts = askDecision.drafts;
  } else {
    state.pendingDrafts = null;
  }

  if (askDecision?.values) mergeValues(state, askDecision.values);

  return askDecision?.message || `What should the ${missingParam.name} be?`;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function handleWorkflowInput(input, obj) {
  if (!obj || !Array.isArray(obj.plugins)) return { handled: false };

  const catalogue = buildWorkflowCatalogue(obj.plugins);
  if (catalogue.length === 0) return { handled: false };

  const activeState = obj.workflowState || null;

  // FIX 4: Before hitting the AI, try to resolve a draft selection locally.
  // This avoids the AI misinterpreting "first option" as a plain continuation
  // and losing the stored draft texts.
  if (activeState?.pendingDrafts) {
    const draftValues = resolveDraftSelection(input, activeState.pendingDrafts);
    if (draftValues) {
      mergeValues(activeState, draftValues);
      activeState.pendingDrafts = null; // drafts consumed

      const missing = getMissingRequired(activeState);
      if (missing.length > 0) {
        const msg = await askForMissingParam(catalogue, activeState, obj, missing[0]);
        return { handled: true, response: msg };
      }

      const result = await executeWorkflow(activeState, obj, input);
      return handleExecutionResult(activeState, obj, result);
    }
  }

  const systemPrompt = buildSystemPrompt(catalogue, activeState);

  let decision;
  try {
    decision = await callWorkflowAI(systemPrompt, input, obj);
  } catch (err) {
    return { handled: false };
  }

  if (!decision || !decision.action) return { handled: false };

  // ── CANCEL ────────────────────────────────────────────────────────────────
  if (decision.action === "cancel") {
    obj.workflowState = null;
    return { handled: true, response: decision.message || "No problem, cancelled that." };
  }

  // ── NONE (no active workflow, unrelated message) ──────────────────────────
  if (decision.action === "none") {
    if (activeState) {
      // AI returned "none" mid-workflow — missed the continuation.
      // Re-run as a targeted ask, passing the ORIGINAL user message so the
      // AI can respond to "idk"/"suggest" signals with actual draft content.
      const missing = getMissingRequired(activeState);
      if (missing.length > 0) {
        const msg = await askForMissingParam(catalogue, activeState, obj, missing[0], input);
        return { handled: true, response: msg };
      }
      const result = await executeWorkflow(activeState, obj, input);
      return handleExecutionResult(activeState, obj, result);
    } else {
      return { handled: false };
    }
  }

  // ── ASK (AI needs more info / offering drafts) ────────────────────────────
  if (decision.action === "ask") {
    const state = activeState;
    if (state) {
      if (decision.values && typeof decision.values === "object") {
        mergeValues(state, decision.values);
      }
      if (decision.drafts && typeof decision.drafts === "object") {
        state.pendingDrafts = decision.drafts;
      } else {
        state.pendingDrafts = null;
      }
    }
    return { handled: true, response: decision.message || "Can you give me a bit more detail?" };
  }

  // ── START (new workflow detected) ─────────────────────────────────────────
  if (decision.action === "start") {
    // FIX 7: If a workflow is already active, don't silently nuke it.
    // Finish or ask about the current one first, unless the user clearly wants
    // to switch (we detect that by checking for a different workflow name).
    if (activeState) {
      const sameWorkflow =
        decision.workflow_name === activeState.workflow.name &&
        (decision.plugin_name || "").toLowerCase() ===
          (activeState.plugin?.data?.name || "").toLowerCase();

      if (!sameWorkflow) {
        // The user is switching workflows mid-session.
        // Finish the old one if all params are ready; otherwise drop it.
        const missing = getMissingRequired(activeState);
        if (missing.length === 0) {
          // Execute the pending workflow first, then start the new one
          const result = await executeWorkflow(activeState, obj, input);
          obj.workflowState = null;
          // We don't return here — fall through to start the new workflow below
          // (the result will be lost but that's an acceptable trade-off; the
          //  alternative is queueing workflows which is much more complex.)
          // TODO: queue the result and return both
        } else {
          // Just drop the incomplete old workflow silently
          obj.workflowState = null;
        }
      }
    }

    const found = findPluginAndWorkflow(obj, decision.plugin_name, decision.workflow_name);
    if (!found) return { handled: false };

    const state = initializeWorkflowState(found.plugin, found.workflow);
    obj.workflowState = state;

    mergeValues(state, decision.values);
    const startResolve = await prefillAndResolve(state, obj, input, catalogue);
    if (startResolve.earlyReturn) return startResolve.earlyReturn;

    const missing = getMissingRequired(state);
    if (missing.length > 0) {
      const msg = await askForMissingParam(catalogue, state, obj, missing[0], input);
      return { handled: true, response: msg };
    }

    const result = await executeWorkflow(state, obj, input);
    return handleExecutionResult(state, obj, result);
  }

  // ── CONTINUE (active workflow, user gave more info) ───────────────────────
  if (decision.action === "continue") {
    if (!activeState) return { handled: false };

    mergeValues(activeState, decision.values);

    // FIX 8: Clear stale pending drafts when user gives explicit values
    if (decision.values && Object.keys(decision.values).length > 0) {
      activeState.pendingDrafts = null;
    }

    const continueResolve = await prefillAndResolve(activeState, obj, input, catalogue);
    if (continueResolve.earlyReturn) return continueResolve.earlyReturn;

    const missing = getMissingRequired(activeState);
    if (missing.length > 0) {
      const msg = await askForMissingParam(catalogue, activeState, obj, missing[0], input);
      return { handled: true, response: msg };
    }

    const result = await executeWorkflow(activeState, obj, input);
    return handleExecutionResult(activeState, obj, result);
  }

  // ── EXECUTE (AI says all params are ready) ────────────────────────────────
  if (decision.action === "execute") {
    if (!activeState) return { handled: false };

    if (decision.values && typeof decision.values === "object") {
      mergeValues(activeState, decision.values);
    }

    // FIX 9: Clear pending drafts on execute
    activeState.pendingDrafts = null;

    const executeResolve = await prefillAndResolve(activeState, obj, input, catalogue);
    if (executeResolve.earlyReturn) return executeResolve.earlyReturn;

    const missing = getMissingRequired(activeState);
    if (missing.length > 0) {
      // Safety net — AI said execute but params aren't actually all there
      const msg = await askForMissingParam(catalogue, activeState, obj, missing[0], input);
      return { handled: true, response: msg };
    }

    const result = await executeWorkflow(activeState, obj, input);
    return handleExecutionResult(activeState, obj, result);
  }

  return { handled: false };
}

module.exports = { handleWorkflowInput };