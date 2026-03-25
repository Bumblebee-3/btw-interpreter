# Plugins Guide

BTW - Interpreter supports community-made plugins that allow GROQ to access external data sources such as APIs, web search engines, local services, etc.

Plugins extend the assistant’s capabilities without modifying the core interpreter.

---

## Runtime Pipeline

Incoming user text is processed in this order:

1. Workflow engine checks active or new workflows.
2. Plugin follow-up hooks run (optional per plugin).
3. Built-in command handler runs.
4. Plugin intent resolution picks a plugin function.
5. If no plugin/command/workflow matches, default LLM answer is used.

Important:
- A follow-up hook may rewrite the query without directly handling it.
- Workflow handling is prioritized before plugin function routing.

---

## Plugin Folder Structure

Each plugin lives in its own folder.

```text
plugins/
    your-plugin/
        plugindata.json
        index.js
```

Required files:
- plugindata.json
- index.js (entrypoint declared in plugindata.json)

---

## plugindata.json

Minimal shape:

```json
{
    "name": "PluginName",
    "description": "What this plugin does",
    "entrypoint": "index.js",
    "plugin_params": ["param1", "param2"],
    "functions": [],
    "workflows": []
}
```

Top-level fields:
- name: plugin display name
- description: short summary
- entrypoint: plugin class file
- plugin_params: constructor args resolved from runtime context (order matters)
- functions: stateless function capabilities
- workflows: stateful action definitions

---

## Function Definitions

Each item in functions maps to one class method.

Example:

```json
{
    "name": "searchOnline",
    "description": "Search and return useful context",
    "async": true,
    "requires_LLM": true,
    "keywords": ["search", "look up", "web"],
    "requires": ["$INPUT"],
    "output_format": "Concise plain text"
}
```

Fields:
- name: must match class method name
- description: purpose of function
- async: true if Promise-based
- requires_LLM:
    - true: plugin result is post-processed by LLM
    - false: raw plugin result is returned
- keywords: heuristic trigger terms
- requires: currently $INPUT is the main value
- output_format: guidance for LLM formatting

### Optional: intent_guard

Functions can define metadata guards for high-precision routing.

```json
"intent_guard": {
    "enabled": true,
    "priority": 90,
    "min_score": 3,
    "min_confidence": 0.35,
    "min_token_ratio": 0.5,
    "keywords": ["inbox", "email", "gmail"]
}
```

Guard behavior:
- Runs before normal heuristic/LLM classification.
- Higher priority wins over lower priority.
- Useful to prevent cross-plugin misroutes for critical intents.

---

## Function Routing Behavior

Plugin function routing is hybrid:

1. intent_guard match (if configured)
2. keyword heuristic scoring
3. LLM classifier fallback when heuristic confidence is low or ambiguous
4. heuristic fallback if classifier is weak/unavailable

Best practice:
- Use focused keywords.
- Add intent_guard for critical routes.
- Keep descriptions short and specific.

---

## Plugin Class Contract

Entrypoint must export a class.

```javascript
class MyPlugin {
    constructor(param1, param2, obj) {
        this.param1 = param1;
        this.param2 = param2;
        this.obj = obj;
    }

    async someFunction(input) {
        return "result";
    }
}

module.exports = MyPlugin;
```

Rules:
- Constructor parameter order must match plugin_params.
- Handle failures gracefully.
- Return stable, predictable outputs (string preferred).

---

## Optional Follow-up Hook

Plugins may implement handleFollowUp(input) for conversational continuity.

Accepted return shapes:

```javascript
{ handled: true, response: "..." }
{ handled: false }
{ handled: false, rewrittenQuery: "..." }
```

Semantics:
- handled true: plugin fully answers the turn.
- handled false + rewrittenQuery: query continues through normal routing, using rewritten text.
- handled false only: no follow-up action.

---

## Stateful Workflows

Workflows are declared in plugindata.json and executed by method name.

Example:

```json
{
    "workflows": [
        {
            "name": "send_email",
            "description": "Collect details and send email",
            "keywords": ["send email", "compose email"],
            "required_params": [
                { "name": "recipient", "description": "Recipient email", "type": "email" },
                { "name": "subject", "description": "Email subject", "type": "string" },
                { "name": "body", "description": "Email body", "type": "string" }
            ],
            "optional_params": [
                { "name": "cc", "description": "Optional CC", "type": "email" }
            ],
            "execute": "sendEmailWorkflow"
        }
    ]
}
```

Workflow notes:
- required_params and optional_params accept strings or objects.
- Missing required params are collected over turns.
- User can cancel with cancel/stop/abort style input.

Execution signature:

```javascript
async sendEmailWorkflow(params, context) {
    return "Done";
}
```

Where:
- params: collected required/optional values
- context.input: latest user turn
- context.workflow: workflow name

---

## Workflow Return Contract

If your workflow needs more user input after execution attempt, return:

```json
{
    "status": "needs_input",
    "field": "recipient",
    "message": "Please provide recipient name or email."
}
```

Behavior:
- Workflow remains active.
- Engine asks for the missing field and continues collection.

Any other return value ends the workflow.

---

## Optional Workflow Prefill Hook

Plugins can implement:

```javascript
async prefillWorkflowParams({ workflow, input, params }) {
    return { recipient: "Alice" };
}
```

Use this to extract parameters from natural phrasing before prompting the user.

---

## Generic Send-Intent Channel Selection

The workflow engine can detect generic send phrasing such as:
- tell X ...
- inform X ...
- notify X ...
- let X know ...

If multiple send workflows exist (for example Gmail and WhatsApp), it asks the user to choose a channel.

This is engine-level behavior and requires no plugin-specific code beyond normal send workflows.

---

## Best Practices

- Keep plugin methods resilient and side-effect safe.
- Never throw uncaught exceptions to the interpreter.
- Prefer generic logic over hardcoded domain examples.
- Use intent_guard for high-risk misroutes.
- Keep workflow prompts and field descriptions clear.
- Return actionable error messages, including interpreted target when useful.

---

## Security

Plugins can access external APIs and local resources.
Install only trusted plugins and protect secrets in config/env files.

---

## Quick Checklist

- plugindata.json has correct entrypoint and plugin_params order
- Class constructor matches plugin_params order
- Every function name exists in class
- Workflow execute method exists in class
- Workflow returns needs_input object when blocked
- Optional handleFollowUp/prefillWorkflowParams implemented if needed
- Error paths return clear text (not stack traces)
