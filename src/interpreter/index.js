const {checkCommands , handleCommand} = require("./commandHandler.js");
const {resolvePluginIntent , handlePlugin, handlePluginFollowUp} = require("./pluginHandler.js");
const {handleWorkflowInput} = require("./workflowHandler.js");
const {answer, callLLM, rewriteQuery, extractContent} = require("./llm.js");
const R = require("./response.js");
const MessageHistory = require("./messageHistory.js");
const {buildRewritePrompt, finalizeRewrite, shouldRewriteQuery} = require("./queryRewrite.js");

const RAG_MIN_SIMILARITY = 40;

async function tryRAGAnswer(query, obj) {
    if (!obj.db || !obj.db.dbPath) return null;

    try {
        const results = await obj.db.searchDB(query, 5, obj.table_config);
        if (!results || results.length === 0) return null;

        const top = results[0];
        const simScore = parseFloat(String(top.similarity || "0").replace("%", ""));
        if (simScore < RAG_MIN_SIMILARITY) return null;

        return results;
    } catch (_) {
        return null;
    }
}

async function arbitrateLowConfidence(query, ragResults, obj) {
    const pluginCatalog = (obj.plugins || []).map(plugin => plugin?.data || {});
    const prompt = `You are the final router for a voice assistant. The initial knowledge-base retrieval was low confidence.
Use BOTH the retrieved RAG data and the available plugin definitions below to decide the best next step.
Return ONLY valid JSON in this exact format:
{"route":"rag"|"plugin"|"general","plugin":"exact plugin name or empty string","function":"exact function name or empty string","reason":"brief explanation"}

Rules:
- Choose "rag" only when the retrieved context directly answers the question.
- Choose "plugin" when a listed plugin can provide a better or current answer. Use its exact name and function.
- Choose "general" only when neither the RAG context nor a plugin is suitable.
- Current, dated, news, sports-result, and public-web factual questions should use a suitable web-search plugin.

Question:
${query}

Retrieved RAG data:
${JSON.stringify(ragResults, null, 2)}

Available plugin definitions:
${JSON.stringify(pluginCatalog, null, 2)}`;

    try {
        const payload = await callLLM(prompt, obj.llm_config);
        const raw = extractContent(payload, obj.llm_config.provider);
        const match = String(raw || "").match(/\{[\s\S]*\}/);
        if (!match) return null;
        const decision = JSON.parse(match[0]);
        if (!["rag", "plugin", "general"].includes(decision.route)) return null;
        return decision;
    } catch (error) {
        console.warn("[ragRouter] Low-confidence arbitration failed:", error.message);
        return null;
    }
}

async function handle(query,obj){
    // Initialize message history if not exists
    if (!obj.messageHistory) {
        obj.messageHistory = new MessageHistory();
    }

    obj.previousUserQuery = obj.lastUserQuery || "";
    obj.lastUserQuery = query;

    const historySnapshot = obj.messageHistory ? obj.messageHistory.getAll() : [];
    let effectiveQuery = query;

    if (shouldRewriteQuery(query, historySnapshot, obj.workflowState, {
        lastToolName: historySnapshot.length > 0 ? historySnapshot[historySnapshot.length - 1].toolName : ""
    })) {
        try {
            const rewritePrompt = buildRewritePrompt(historySnapshot, query);
            const rewrittenQuery = await rewriteQuery(rewritePrompt, obj.llm_config);
            effectiveQuery = finalizeRewrite(query, rewrittenQuery);
        } catch (_) {
        }
    }

    const finalize = (response, toolName, rawToolData, responseType) => {
        // backwards compat: bare strings become text type
        if (typeof response === "string") {
            // parse out LINK:[url] that Tavily and Gmail already embed
            const linkMatch = response.match(/LINK:\[(https?:\/\/[^\]]+)\]/);
            if (linkMatch) {
                const url = linkMatch[1];
                const content = response.replace(/LINK:\[.*?\]/, "").trim();
                response = R.rich(content, [{ label: "Open", type: "open_url", value: url }], [toolName,rawToolData]);
            } else {
                response = R.text(response,[toolName,rawToolData]);
            }
        } else if (!response || typeof response !== "object" || !response.type) {
            response = R.text(JSON.stringify(response ?? null),[toolName,rawToolData]);
        }
        
        // Record the turn in memory
        const turn = {
            timestamp: `${Math.floor((Date.now() - (obj.lastTurnTimestamp || Date.now())) / 1000)}s ago`,
            userQuery: query,
            toolName: toolName || null,
            rawToolData: rawToolData || null,
            llmFormattedResult: response.content || response,
            responseType: responseType || "text"
        };
        
        obj.messageHistory.addTurn(turn);
        obj.lastTurnTimestamp = Date.now();
        
        obj.lastAssistantResponse = response;
        global.__btwLastAssistantResponse = response;
        return response;
    };

    // Handle workflow
    const workflowResult = await handleWorkflowInput(effectiveQuery, obj);
    if (workflowResult.handled) {
        return finalize(workflowResult.response, `workflow:${workflowResult.workflowName || 'unknown'}`, workflowResult.response, "text");
    }

    // Handle plugin follow-up
    const pluginFollowUp = await handlePluginFollowUp(effectiveQuery, obj);
    if (pluginFollowUp.handled) {
        return finalize(pluginFollowUp.response, `followup:${pluginFollowUp.pluginName || 'unknown'}`, null, "text");
    }

    const routingQuery = (pluginFollowUp && typeof pluginFollowUp.rewrittenQuery === "string" && pluginFollowUp.rewrittenQuery.trim())
        ? pluginFollowUp.rewrittenQuery.trim()
        : effectiveQuery;

    // Check confident RAG results before command and plugin routing.
    const ragResults = await tryRAGAnswer(routingQuery, obj);
    if (ragResults) {
        const ragContext = ragResults
            .map((result) => `${result.text} (similarity: ${result.similarity})`)
            .join("\n");
        const ragPrompt =
            "You are Bumblebee, a helpful voice assistant. " +
            "Answer the user's question concisely in 1-2 sentences using ONLY the context below. " +
            "Plain text only, no markdown. If the context does not answer the question, reply with exactly: __RAG_INSUFFICIENT__\n\n" +
            "Context:\n" + ragContext + "\n\n" +
            "Question: " + routingQuery;
        const ragAnswer = await obj.customQuery(ragPrompt);

        const hasRagAnswer = typeof ragAnswer === "string" &&
            ragAnswer.trim() &&
            !ragAnswer.includes("__RAG_INSUFFICIENT__") &&
            !ragAnswer.startsWith("Model error:");
        if (hasRagAnswer) {
            return finalize(ragAnswer, "rag", ragResults, "text");
        }
    }

    let c = await checkCommands(routingQuery,obj);
    //console.log(c);
    if(c.isCommand==true){
        const commandResult = await handleCommand(c.cmd,c.params);
        return finalize(commandResult, `command:${c.cmd.id}`, commandResult, "text");
    } else {
        const lowConfidenceResults = await obj.db?.searchDB?.(routingQuery, 5, obj.table_config);
        const topSimilarity = parseFloat(String(lowConfidenceResults?.[0]?.similarity || "0").replace("%", ""));
        if (lowConfidenceResults?.length && topSimilarity < RAG_MIN_SIMILARITY) {
            const decision = await arbitrateLowConfidence(routingQuery, lowConfidenceResults, obj);
            if (decision?.route === "rag") {
                const ragPrompt = "Answer the user's question using only this retrieved context. If it does not answer the question, say __RAG_INSUFFICIENT__.\n\nContext:\n" + JSON.stringify(lowConfidenceResults) + "\n\nQuestion: " + routingQuery;
                const ragAnswer = await obj.customQuery(ragPrompt);
                if (ragAnswer && !ragAnswer.includes("__RAG_INSUFFICIENT__")) {
                    return finalize(ragAnswer, "rag", lowConfidenceResults, "text");
                }
            } else if (decision?.route === "plugin") {
                const resolved = (obj.plugins || []).flatMap(plugin => (plugin.data.functions || []).map(func => ({ plugin, function: func })))
                    .find(item => item.plugin.data.name === decision.plugin && item.function.name === decision.function);
                if (resolved) {
                    const pluginResult = await handlePlugin(resolved.plugin, resolved.function, routingQuery, obj.llm_config, obj);
                    return finalize(pluginResult, `${resolved.plugin.data.name}.${resolved.function.name}`, pluginResult, "text");
                }
            } else if (decision?.route === "general") {
                const llmResponse = await answer(routingQuery, obj.llm_config, false, obj);
                return finalize(llmResponse, null, null, "text");
            }
        }
        let p= await resolvePluginIntent(routingQuery,obj);
        if(p.isPlugin==true){
            const pluginResult = await handlePlugin(p.plugin, p.function, routingQuery, obj.llm_config, obj);
            return finalize(pluginResult, `${p.plugin.data.name}.${p.function.name}`, pluginResult, "text");
        } else {
            // Plain LLM fallback
            const llmResponse = await answer(routingQuery, obj.llm_config, false, obj);
            return finalize(llmResponse, null, null, "text");
        }
    }
}

module.exports = {
    handle
}
