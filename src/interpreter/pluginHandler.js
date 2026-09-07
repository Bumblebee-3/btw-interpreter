//REQUIRES AI LAYER

const path = require("path");
const {answer,plugin_answer, callLLMSmall, extractContent} = require("./llm.js");

function buildFunctionCatalog(plugins) {
    const catalog = [];
    for (const plugin of plugins || []) {
        const pluginName = String(plugin?.data?.name || "").trim();
        for (const func of plugin?.data?.functions || []) {
            catalog.push({
                pluginName,
                functionName: String(func?.name || "").trim(),
                pluginDescription: String(plugin?.data?.description || ""),
                description: String(func?.description || ""),
                keywords: Array.isArray(func?.keywords) ? func.keywords : []
            });
        }
    }
    return catalog;
}

function findPluginFunction(plugins, pluginName, functionName) {
    const pName = String(pluginName || "").trim().toLowerCase();
    const fName = String(functionName || "").trim().toLowerCase();

    for (const plugin of plugins || []) {
        if (String(plugin?.data?.name || "").trim().toLowerCase() !== pName) continue;
        for (const func of plugin?.data?.functions || []) {
            if (String(func?.name || "").trim().toLowerCase() === fName) {
                return { plugin, function: func };
            }
        }
    }
    return null;
}

function buildRoutingPrompt(query, catalog) {
    return `You are a router for a voice assistant. Given a user query, decide if it maps to a specific plugin function.
Return ONLY valid JSON matching this schema exactly:
{
  "route": "plugin" | "none",
  "plugin": "exact plugin name or empty string",
  "function": "exact function name or empty string",
  "confidence": 0.0,
  "reason": "one sentence"
}

Rules:
- Only use plugin/function names from the catalog below. Never invent names.
- route="none" means answer with general LLM knowledge; no plugin is needed.
- Prefer the most specific function when multiple plugins could apply.
- Do not route local device-control requests such as changing brightness, volume, locking, or shutting down to a web-search plugin; those belong to the local command router.
- Email or inbox queries use the Gmail plugin.
- Browser navigation, URLs, or page inspection use the Browser plugin.
- Use the Tavily plugin for information that should be looked up on the public web rather than answered from model memory.
- This includes current or time-sensitive facts, factual questions about events in a specific year, sports results or champions, news, reviews, rankings, prices, and questions asking what happened or who won.
- For example, "who won the Formula 1 championship of 2025" must route to Tavily because the answer is a factual event result that should be verified online.
- Messaging or chat summaries use the WhatsApp plugin.
- Only use route="none" when no catalog function can provide the requested information. Do not lower confidence for a clear Tavily lookup; use confidence 0.8 or higher.

User query: ${JSON.stringify(String(query || ""))}
Available functions:
${JSON.stringify(catalog, null, 2)}`;
}

async function classifyPluginIntentWithLLM(query, obj) {
    if (!obj || !obj.llm_config) return { isPlugin: false };

    const catalog = buildFunctionCatalog(obj.plugins);
    if (!catalog.length) return { isPlugin: false };

    try {
        const payload = await Promise.race([
            callLLMSmall(buildRoutingPrompt(query, catalog), obj.llm_config),
            new Promise((_, reject) => setTimeout(() => reject(new Error("LLM routing timeout")), 5000))
        ]);
        const raw = extractContent(payload, obj.llm_config.provider);
        const match = String(raw || "").match(/\{[\s\S]*\}/);
        if (!match) return { isPlugin: false };
        const parsed = JSON.parse(match[0]);
        if (String(parsed.route || "").toLowerCase() !== "plugin") return { isPlugin: false };

        const resolved = findPluginFunction(obj.plugins, parsed.plugin, parsed.function);
        if (!resolved) return { isPlugin: false };

        return {
            isPlugin: true,
            plugin: resolved.plugin,
            function: resolved.function,
            confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
            via: "llm"
        };
    } catch (err) {
        console.warn("[pluginRouter] LLM routing failed:", err.message);
        return { isPlugin: false };
    }
}

async function resolvePluginIntent(query, obj) {
    const llm = await classifyPluginIntentWithLLM(query, obj);
    if (llm?.isPlugin && llm.confidence >= 0.55) {
        return llm;
    }
    return { isPlugin: false };
}


function loadPlugin(plugin, ctx) {
    const loc = path.resolve(path.dirname(plugin.location), plugin.data.entrypoint);
    const cls = require(loc);

    const args = plugin.data.plugin_params.map(param => {
        if (ctx?.[param] !== undefined) {
            return ctx[param];
        }
        return null;
    });
    return new cls(...args);
}

async function callPluginFunction(instance, funcd, input) {
    const method = funcd.name;
    if (typeof instance[method] !== "function") {
        throw new Error(`Function ${method} not found on plugin`);
    }
    return await instance[method](input);
}

async function handlePlugin(plugin,func,query,apiConfig,ctx){
    const pluginInstance = loadPlugin(plugin, plugin.params);
    const result = await callPluginFunction(pluginInstance,func,query);
    
    // Store the raw result for memory tracking
    if (func.requires_LLM === false) {
        // For plugins that don't require LLM, we return the raw data directly 
        // This is handled by the caller in interpreter/index.js to record it in history
        return result;
    } else {
        // For plugins that do require LLM, we process with plugin_answer
        if(func.custom_prompt==true){
            return await answer(query,apiConfig,true,ctx);
        }
        return await plugin_answer(query,apiConfig,func,result,ctx);
    }
}

async function handlePluginFollowUp(query, obj) {
    let rewrittenQuery = "";
    for (const plugin of obj.plugins) {
        try {
            const instance = loadPlugin(plugin, plugin.params);
            if (typeof instance.handleFollowUp !== "function") continue;

            const result = await instance.handleFollowUp(query);
            if (result && result.handled) {
                return result;
            }

            if (result && !result.handled && typeof result.rewrittenQuery === "string" && result.rewrittenQuery.trim()) {
                rewrittenQuery = result.rewrittenQuery.trim();
            }
        } catch (err) {
            console.warn(`[followUp] Plugin ${plugin?.data?.name || "unknown"} failed:`, err.message);
        }
    }

    return { handled: false, rewrittenQuery };
}

module.exports = {
    resolvePluginIntent,
    handlePlugin,
    loadPlugin,
    callPluginFunction,
    handlePluginFollowUp
}