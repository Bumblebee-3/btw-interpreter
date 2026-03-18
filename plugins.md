# Plugins Guide

BTW - Interpreter supports community-made plugins that allow GROQ to access external data sources such as APIs, web search engines, local services, etc.

Plugins extend the assistant’s capabilities without modifying the core interpreter.

---

## How Plugins Work

1. User query is received.
2. Keyword matcher checks loaded plugins.
3. If keywords match, the plugin function is triggered.
4. Plugin returns data.
5. Returned data is injected into GROQ as a system prompt.
6. GROQ generates the final response using that data.

Plugins do **not** directly answer the user unless explicitly designed to. They provide structured context to the LLM.

---

## Plugin Structure

Each plugin must have its own directory inside your plugins folder:

```
plugins/
   your-plugin/
      plugindata.json
      index.js
```

### Required Files

- `plugindata.json` (compulsory)
- `index.js` (entrypoint defined in plugindata.json)

---

# plugindata.json

This file defines the plugin metadata and how it integrates with the interpreter.

Example:

```json
{
    "name":"Tavily",
    "description":"Web Queries functionality to AI",
    "entrypoint":"index.js",
    "plugin_params":["search_depth","country","tavily_api_key"],
    
    "functions":[
        {
            "name":"searchOnline",
            "description":"Searches online for given input and answer the question.",
            "async":true,
            "requires_LLM":false,
            "keywords": [
                "today", "now", "current", "latest", "recent", "breaking","this week","this month","this year",
                "news", "headline", "report", "announcement","release","verdict","launch",
                "won", "lost", "results", "score",
                "price", "cost", "fees", "rate", "stock", "market",
                "available", "availability", "where to buy", "tickets","booking",
                "compare", "vs", "versus", "difference", "better than",
                "pros and cons", "best", "top", "ranking", "review",
                "statistics", "stats", "data", "research", "study", "analysis",
                "how to", "guide", "tutorial", "steps", "documentation",
                "2022", "2023", "2024", "2025", "2026","in my area","near me","setup","official","figures"
            ],
            "requires":["$INPUT"],
            "output_format": "Lionel Messi, born in 1987, is an Argentine footballer widely regarded as one of the greatest players of his generation..."
        }
    ]
}
```

---

## Field Explanation

### name
Name of the plugin.

### description
Short description of what the plugin does.

### entrypoint
Main file that exports the plugin class.

### plugin_params
Parameters passed into the constructor of your plugin class.

---

## Function Object Fields

Each function inside `"functions"` defines one callable capability.

### name
Name of the method inside your class.

### description
What the function does.

### async
Set to `true` if the function returns a Promise.

### requires_LLM
If `true`, output will be processed again by GROQ before responding.  
If `false`, output is injected directly.

### keywords
If the user query contains any of these keywords, this function may trigger.

### requires
Special variables:
- `$INPUT` → Full user query
- (Future extensibility supported)

### output_format
Example format of the output. This helps GROQ understand how to structure the final response.

---

# index.js

Your entrypoint must export a class.

Example:

```javascript
class Tavily {
    constructor(search_depth, country, tavily_api_key) {
        this.search_depth = search_depth;
        this.country = country;
        this.tavily_api_key = tavily_api_key;
    }

    async searchOnline(input) {
        try {
            const payload = {
                query: input,
                include_answer: "basic",
                search_depth: "advanced"
            };

            const response = await fetch("https://api.tavily.com/search", {
                method: "POST",
                headers: {
                    "Authorization": \`Bearer \${this.tavily_api_key}\`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                console.warn("HTTP error:", response.status);
                return "Tavily failed.";
            }

            const data = await response.json();

            return (
                data.answer ||
                data.results?.[0]?.content ||
                "Tavily failed."
            );

        } catch (err) {
            console.warn("Fetch error:", err);
            return "Tavily failed.";
        }
    }
}

module.exports = Tavily;
```

---

## Constructor Rules

The constructor parameters must match `plugin_params` in `plugindata.json`.

If your `plugin_params` is:

```json
"plugin_params":["search_depth","country","tavily_api_key"]
```

Then your constructor must be:

```javascript
constructor(search_depth, country, tavily_api_key)
```

Order matters.

---

## Best Practices

- Keep plugins stateless when possible.
- Handle API failures gracefully.
- Never crash the interpreter.
- Always return a string.
- Avoid blocking operations unless necessary.
- Validate required parameters before making external requests.

---

## Security Notice

Plugins can access external APIs and system data.  
Only install trusted plugins.

---

## Final Notes

Plugins are designed to:
- Inject live data
- Extend functionality
- Keep the core interpreter minimal
- Allow community-driven expansion

Build responsibly.

---

# Action Workflows (Stateful)

Plugins can also define stateful workflows for actions like sending emails, creating calendar events, posting to chat apps, etc.

Workflows are declarative and live in `plugindata.json` under a top-level `workflows` array.

Example:

```json
{
    "workflows": [
        {
            "name": "send_email",
            "description": "Collect details and send an email",
            "keywords": ["send email", "compose email"],
            "required_params": [
                { "name": "recipient", "description": "Please provide recipient email.", "type": "email" },
                { "name": "subject", "description": "Please provide subject.", "type": "string" },
                { "name": "body", "description": "Please provide body.", "type": "string" }
            ],
            "optional_params": [
                { "name": "cc", "description": "Optional CC email.", "type": "email" }
            ],
            "execute": "sendEmailWorkflow"
        }
    ]
}
```

Rules:
- `required_params` can be either strings or objects.
- `optional_params` can be either strings or objects.
- `execute` must be a method name implemented in your plugin class.
- The interpreter will collect missing required params over multiple turns.
- If a required param already exists in user input, it will not be asked again.
- Once all required params are available, the interpreter executes the workflow automatically.
- User can cancel active workflow by saying cancel/stop/abort.

Execution signature in plugin class:

```javascript
async sendEmailWorkflow(params, context) {
    // params contains required and optional values
    // context contains runtime metadata
    return "Done";
}
```

This mechanism is plugin-agnostic, so the same pattern works for Gmail, Calendar, WhatsApp, Signal, Discord, and future integrations.
