const path = require("path");
const {answer,plugin_answer} = require("./groq.js");

function normalizeText(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9@._-\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function toTokenSet(text) {
    return new Set(normalizeText(text).split(/[^a-z0-9@._-]+/i).filter(Boolean));
}

function scoreKeywordList(query, keywords, minRatio = 0.66) {
    const qNorm = normalizeText(query);
    if (!qNorm) return { score: 0, confidence: 0 };

    const qTokens = toTokenSet(qNorm);
    let score = 0;

    for (const keyword of keywords || []) {
        const keyNorm = normalizeText(keyword);
        if (!keyNorm) continue;

        if (qNorm.includes(keyNorm)) {
            const tokenCount = keyNorm.split(/\s+/).filter(Boolean).length;
            score += Math.max(1, tokenCount) * 3;
            continue;
        }

        const keyTokens = keyNorm.split(/[^a-z0-9@._-]+/i).filter(Boolean);
        if (!keyTokens.length) continue;

        let hits = 0;
        for (const token of keyTokens) {
            if (qTokens.has(token)) hits++;
        }

        const ratio = hits / keyTokens.length;
        if (ratio >= minRatio) {
            score += Math.max(1, keyTokens.length) * ratio * 2;
        }
    }

    const maxScore = Math.max(1, (keywords || []).length * 3);
    return {
        score,
        confidence: Math.max(0, Math.min(1, score / maxScore))
    };
}

function checkPlugins(query, obj) {
    const inp = normalizeText(query);
    const inpTokens = new Set(inp.split(/[^a-z0-9@._-]+/i).filter(Boolean));
    const plugins = obj.plugins;
    const ranked = [];
    let best = {
        score: 0,
        specificity: 0,
        confidence: 0,
        plugin: null,
        function: null,
        isPlugin:false
    };
    for (const plugin of plugins) {
        for (const func of plugin.data.functions) {
            let score = 0;
            let specificity = 0;
            for (const keyword of func.keywords) {
                const normalizedKeyword = String(keyword || "").toLowerCase().trim();
                if (!normalizedKeyword) continue;

                if (inp.includes(normalizedKeyword)) {
                    const tokenCount = normalizedKeyword.split(/\s+/).filter(Boolean).length;
                    score += Math.max(1, tokenCount) * 3;
                    specificity += normalizedKeyword.length;
                    continue;
                }

                const keyTokens = normalizedKeyword.split(/[^a-z0-9@._-]+/i).filter(Boolean);
                if (keyTokens.length === 0) continue;

                let hits = 0;
                for (const token of keyTokens) {
                    if (inpTokens.has(token)) hits++;
                }

                const ratio = hits / keyTokens.length;
                if (ratio >= 0.66) {
                    score += Math.max(1, keyTokens.length) * ratio * 2;
                    specificity += normalizedKeyword.length * ratio;
                }
            }

            if (score > 0) {
                ranked.push({
                    score,
                    specificity,
                    plugin,
                    function: func
                });
            }

            if (score > best.score || (score === best.score && specificity > best.specificity)) {
                best.score = score;
                best.specificity = specificity;
                best.plugin = plugin;
                best.function = func;
                best.isPlugin = true;
            }
        }
    }

    ranked.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.specificity - a.specificity;
    });

    const confidence = Math.max(0, Math.min(1, best.score / 12));
    const second = ranked[1] || null;
    const ambiguity = second
        ? Math.max(0, Math.min(1, (best.score - second.score) / Math.max(1, best.score)))
        : 1;

    if (best.score === 0) {
        return {
            isPlugin:false,
            confidence: 0,
            ambiguity: 0,
            ranked: []
        };
    }

    best.confidence = confidence;
    best.ambiguity = ambiguity;
    best.ranked = ranked.slice(0, 5);
    return best;
}

function shouldUseLLMClassifier(heuristicResult) {
    if (!heuristicResult || !heuristicResult.isPlugin) return true;
    if (heuristicResult.confidence < 0.72) return true;
    if (heuristicResult.ambiguity < 0.2) return true;
    return false;
}

function buildFunctionCatalog(plugins) {
    const catalog = [];
    for (const plugin of plugins || []) {
        const pluginName = String(plugin?.data?.name || "").trim();
        for (const func of plugin?.data?.functions || []) {
            catalog.push({
                pluginName,
                functionName: String(func?.name || "").trim(),
                description: String(func?.description || ""),
                keywords: Array.isArray(func?.keywords) ? func.keywords.slice(0, 20) : []
            });
        }
    }
    return catalog;
}

function findPluginFunction(plugins, pluginName, functionName) {
    const pName = normalizeText(pluginName);
    const fName = normalizeText(functionName);

    for (const plugin of plugins || []) {
        if (normalizeText(plugin?.data?.name) !== pName) continue;
        for (const func of plugin?.data?.functions || []) {
            if (normalizeText(func?.name) === fName) {
                return { plugin, function: func };
            }
        }
    }
    return null;
}

function resolveGuardedIntent(query, plugins) {
    let best = null;

    for (const plugin of plugins || []) {
        for (const func of plugin?.data?.functions || []) {
            const guard = func?.intent_guard;
            if (!guard || guard.enabled === false) continue;

            const keywords = Array.isArray(guard.keywords) ? guard.keywords : [];
            if (!keywords.length) continue;

            const minRatio = Number.isFinite(Number(guard.min_token_ratio))
                ? Number(guard.min_token_ratio)
                : 0.66;
            const minScore = Number.isFinite(Number(guard.min_score))
                ? Number(guard.min_score)
                : 3;
            const minConfidence = Number.isFinite(Number(guard.min_confidence))
                ? Number(guard.min_confidence)
                : 0.35;
            const priority = Number.isFinite(Number(guard.priority))
                ? Number(guard.priority)
                : 0;

            const scored = scoreKeywordList(query, keywords, minRatio);
            if (scored.score < minScore || scored.confidence < minConfidence) continue;

            const candidate = {
                plugin,
                function: func,
                score: scored.score,
                confidence: scored.confidence,
                priority
            };

            if (!best) {
                best = candidate;
                continue;
            }

            if (candidate.priority > best.priority) {
                best = candidate;
                continue;
            }

            if (candidate.priority === best.priority && candidate.score > best.score) {
                best = candidate;
            }
        }
    }

    if (!best) return null;
    return {
        isPlugin: true,
        plugin: best.plugin,
        function: best.function,
        confidence: best.confidence,
        via: "metadata_guard"
    };
}

async function classifyPluginIntentWithLLM(query, obj, heuristicResult) {
    if (!obj || typeof obj.customQuery !== "function") return null;

    const catalog = buildFunctionCatalog(obj.plugins);
    if (!catalog.length) return null;

    const heuristicHints = (heuristicResult?.ranked || [])
        .slice(0, 3)
        .map(item => ({
            plugin: item.plugin?.data?.name,
            function: item.function?.name,
            score: item.score
        }));

    const prompt =
`Classify the user query to one plugin function.
Return JSON only with schema:
{
  "route": "plugin|none",
  "plugin": "exact plugin name or empty",
  "function": "exact function name or empty",
  "confidence": number,
  "reason": "short"
}

Rules:
- Use only functions listed below.
- If no clear plugin function applies, set route="none".
- Prefer WhatsApp for chat/message-summary intents.
- Prefer Tavily for explicit web lookup/search/news/review intents.
- confidence range 0..1.

Query: ${JSON.stringify(String(query || ""))}
Heuristic top candidates: ${JSON.stringify(heuristicHints)}
Available functions: ${JSON.stringify(catalog)}
`;

    try {
        const raw = await obj.customQuery(prompt);
        const match = String(raw || "").match(/\{[\s\S]*\}/);
        if (!match) return null;
        const parsed = JSON.parse(match[0]);
        if (String(parsed.route || "").toLowerCase() !== "plugin") return { isPlugin: false };

        const resolved = findPluginFunction(obj.plugins, parsed.plugin, parsed.function);
        if (!resolved) return null;

        return {
            isPlugin: true,
            plugin: resolved.plugin,
            function: resolved.function,
            confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
            via: "llm"
        };
    } catch (_) {
        return null;
    }
}

async function resolvePluginIntent(query, obj) {
    const guarded = resolveGuardedIntent(query, obj?.plugins || []);
    if (guarded) {
        return guarded;
    }

    const heuristic = checkPlugins(query, obj);
    if (!shouldUseLLMClassifier(heuristic)) {
        return { ...heuristic, via: "heuristic" };
    }

    const llm = await classifyPluginIntentWithLLM(query, obj, heuristic);
    if (llm?.isPlugin && llm.confidence >= 0.55) {
        return llm;
    }

    if (heuristic?.isPlugin && heuristic.confidence >= 0.45) {
        return { ...heuristic, via: "heuristic_fallback" };
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

async function handlePlugin(plugin,func,query,gapi,ctx){
    const pluginInstance = loadPlugin(plugin, plugin.params);
    const result = await callPluginFunction(pluginInstance,func,query);
    if (func.requires_LLM==true){
        if(func.custom_prompt==true){
            return await answer(query,gapi,true,ctx);
        }
        return await plugin_answer(query,gapi,func,result,ctx);
    }
    return result;
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
        } catch (_) {
        }
    }

    return { handled: false, rewrittenQuery };
}

module.exports = {
    checkPlugins,
    resolvePluginIntent,
    handlePlugin,
    loadPlugin,
    callPluginFunction,
    handlePluginFollowUp
}