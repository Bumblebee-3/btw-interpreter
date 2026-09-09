const {checkCommands , handleCommand} = require("./commandHandler.js");
const {resolvePluginIntent , handlePlugin, handlePluginFollowUp} = require("./pluginHandler.js");
const {handleWorkflowInput} = require("./workflowHandler.js");
const {answer, callLLM, rewriteQuery, extractContent} = require("./llm.js");
const R = require("./response.js");
const MessageHistory = require("./messageHistory.js");
const {buildRewritePrompt, finalizeRewrite, shouldRewriteQuery} = require("./queryRewrite.js");
const { planAndRetrieve } = require("./ragPlanner.js");

const RAG_MIN_SIMILARITY = 40;

// Detect if the user is explicitly asking to search the local database
function isExplicitRAGRequest(query) {
    const t = String(query || "").toLowerCase();
    return /\b(database|dataset|my (data|db|docs|documents|knowledge|notes|files|rag)|uploaded|ingested|stored|in (the |my )?(db|rag|knowledge base|local|dataset)|refer to|look (it |that )?up in|search (my|the) (db|data|docs|knowledge))\b/.test(t);
}

// Detect if the last assistant turn was a RAG answer
function lastTurnWasRAG(obj) {
    const history = obj.messageHistory ? obj.messageHistory.getAll() : [];
    if (history.length === 0) return false;
    const last = history[history.length - 1];
    const toolName = String(last?.toolName || "");
    return toolName === "rag" || toolName === "rag:planned" || toolName.startsWith("rag");
}

// Re-query the specific table that had the best hit, with a higher limit
async function deepQueryBestTable(query, obj, initialResults) {
    if (!initialResults || initialResults.length === 0) return initialResults;
    if (!obj.db || typeof obj.db.queryTable !== "function") return initialResults;

    // Figure out which table the top hit came from by trying each table
    const tableNames = obj.table_config ? Object.keys(obj.table_config) : [];
    if (tableNames.length === 0) return initialResults;

    // Search each table individually to find which one owns the top result
    let bestTable = null;
    let bestScore = -1;

    for (const tableName of tableNames) {
        try {
            const tableResults = await obj.db.queryTable(tableName, query, 3);
            if (!tableResults || tableResults.length === 0) continue;
            const score = parseFloat(String(tableResults[0].similarity || "0").replace("%", ""));
            if (score > bestScore) {
                bestScore = score;
                bestTable = tableName;
            }
        } catch (_) {
            continue;
        }
    }

    if (!bestTable || bestScore < RAG_MIN_SIMILARITY) return initialResults;

    // Re-query that table with a much higher limit to get thorough coverage
    try {
        const deepResults = await obj.db.queryTable(bestTable, query, 15);
        if (!deepResults || deepResults.length === 0) return initialResults;

        // Merge: deep results first (they're from the best table), then any
        // results from other tables that weren't already covered
        const deepTexts = new Set(deepResults.map(r => r.text.slice(0, 80)));
        const extras = initialResults.filter(r => !deepTexts.has(r.text.slice(0, 80)));

        console.log(`[RAG] Deep queried table "${bestTable}": ${deepResults.length} chunks`);
        return [...deepResults, ...extras];
    } catch (_) {
        return initialResults;
    }
}

async function tryRAGAnswer(query, obj) {
    if (!obj.db || !obj.db.dbPath) return null;

    try {
        const results = await obj.db.searchDB(query, 5, obj.table_config);
        if (!results || results.length === 0) return null;

        const top = results[0];
        const simScore = parseFloat(String(top.similarity || "0").replace("%", ""));
        if (simScore < RAG_MIN_SIMILARITY) return null;

        // Deep-query the best table for thorough coverage
        const enrichedResults = await deepQueryBestTable(query, obj, results);
        return enrichedResults;
    } catch (_) {
        return null;
    }
}

// Force a comprehensive RAG search regardless of similarity threshold
async function forceRAGSearch(query, obj) {
    if (!obj.db || !obj.db.dbPath) return null;

    try {
        // Search all tables with a generous limit
        const results = await obj.db.searchDB(query, 10, obj.table_config);
        if (!results || results.length === 0) return null;

        // Deep-query the best matching table regardless of score
        const tableNames = obj.table_config ? Object.keys(obj.table_config) : [];
        let bestTable = null;
        let bestScore = -1;

        for (const tableName of tableNames) {
            try {
                const tableResults = await obj.db.queryTable(tableName, query, 3);
                if (!tableResults || tableResults.length === 0) continue;
                const score = parseFloat(String(tableResults[0].similarity || "0").replace("%", ""));
                if (score > bestScore) {
                    bestScore = score;
                    bestTable = tableName;
                }
            } catch (_) {
                continue;
            }
        }

        if (bestTable) {
            const deepResults = await obj.db.queryTable(bestTable, query, 20);
            if (deepResults && deepResults.length > 0) {
                const deepTexts = new Set(deepResults.map(r => r.text.slice(0, 80)));
                const extras = results.filter(r => !deepTexts.has(r.text.slice(0, 80)));
                console.log(`[RAG:force] Deep queried table "${bestTable}": ${deepResults.length} chunks`);
                return [...deepResults, ...extras];
            }
        }

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

async function handle(query, obj) {
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
        if (typeof response === "string") {
            const linkMatch = response.match(/LINK:\[(https?:\/\/[^\]]+)\]/);
            if (linkMatch) {
                const url = linkMatch[1];
                const content = response.replace(/LINK:\[.*?\]/, "").trim();
                response = R.rich(content, [{ label: "Open", type: "open_url", value: url }], [toolName, rawToolData]);
            } else {
                response = R.text(response, [toolName, rawToolData]);
            }
        } else if (!response || typeof response !== "object" || !response.type) {
            response = R.text(JSON.stringify(response ?? null), [toolName, rawToolData]);
        }

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

    // --- Explicit RAG request: user said "search my database / refer to uploaded docs" etc ---
    if (isExplicitRAGRequest(routingQuery)) {
        console.log("[RAG] Explicit database request detected, forcing comprehensive search");
        const forcedResults = await forceRAGSearch(routingQuery, obj);
        if (forcedResults && forcedResults.length > 0) {
            const isWorkbench = obj?.workbench === true;
            const ragContext = forcedResults
                .map(r => `${r.text} (similarity: ${r.similarity})`)
                .join("\n\n");
            const ragPrompt = isWorkbench
                ? `You are operating in workbench mode. Give a complete, detailed answer using markdown where helpful.\n\nUser request: ${routingQuery}\n\nKnowledge base context:\n${ragContext}\n\nAnswer using only the context above. If the context is insufficient, say so explicitly.`
                : `You are Bumblebee, a helpful voice assistant. Answer using ONLY the knowledge base context below. Plain text only, no markdown.\n\nContext:\n${ragContext}\n\nQuestion: ${routingQuery}`;
            const forcedAnswer = await obj.customQuery(ragPrompt);
            if (forcedAnswer?.trim() && !forcedAnswer.startsWith("Model error:")) {
                return finalize(forcedAnswer, "rag:forced", forcedResults, "text");
            }
        }
        // If the db had nothing, fall through normally rather than hard-failing
    }

    // --- RAG follow-up: last turn was a RAG answer, bias this turn back to RAG ---
    if (lastTurnWasRAG(obj) && !isExplicitRAGRequest(routingQuery)) {
        console.log("[RAG] Follow-up after RAG turn detected, re-querying with effective query");
        const followUpResults = await forceRAGSearch(routingQuery, obj);
        if (followUpResults && followUpResults.length > 0) {
            const isWorkbench = obj?.workbench === true;

            // Build context from this turn's results plus the previous RAG raw data
            const prevRawData = (() => {
                const history = obj.messageHistory ? obj.messageHistory.getAll() : [];
                const last = history[history.length - 1];
                if (!last?.rawToolData) return "";
                if (Array.isArray(last.rawToolData)) {
                    return last.rawToolData
                        .filter(r => r && typeof r === "object" && r.text)
                        .map(r => r.text)
                        .join("\n");
                }
                return "";
            })();

            const ragContext = followUpResults
                .map(r => `${r.text} (similarity: ${r.similarity})`)
                .join("\n\n");

            const combinedContext = prevRawData
                ? `[Context from previous answer]\n${prevRawData}\n\n[Additional retrieved context]\n${ragContext}`
                : ragContext;

            const followUpPrompt = isWorkbench
                ? `You are operating in workbench mode. The user is asking a follow-up question after a previous answer from the knowledge base.\n\nPrevious question: ${obj.previousUserQuery || ""}\nFollow-up question: ${routingQuery}\n\nKnowledge base context:\n${combinedContext}\n\nAnswer the follow-up using the context. Use markdown where helpful.`
                : `You are Bumblebee, a helpful voice assistant. The user is asking a follow-up to a previous answer. Answer using ONLY the knowledge base context. Plain text, no markdown.\n\nPrevious question: ${obj.previousUserQuery || ""}\nFollow-up: ${routingQuery}\n\nContext:\n${combinedContext}`;

            const followUpAnswer = await obj.customQuery(followUpPrompt);
            if (followUpAnswer?.trim() &&
                !followUpAnswer.includes("__RAG_INSUFFICIENT__") &&
                !followUpAnswer.startsWith("Model error:")) {
                return finalize(followUpAnswer, "rag:followup", followUpResults, "text");
            }
            // If RAG had nothing useful for the follow-up, fall through to normal routing
            // so a genuine topic change (e.g. "what's the weather") still works
        }
    }

    // --- RAG: single-shot fast path (high confidence) ---
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
        // Single-shot had chunks but LLM said insufficient — fall through to planning loop
    }

    // --- RAG: planning loop for complex / multi-concept queries ---
    const plannedRAG = await planAndRetrieve(routingQuery, obj);
    if (plannedRAG) {
        const isWorkbench = obj?.workbench === true;
        const synthesisPrompt = isWorkbench
            ? `You are operating in workbench mode. Give a complete, detailed answer using markdown where helpful.\n\nUser request: ${routingQuery}\n\nRetrieved knowledge base context:\n${plannedRAG.context}\n\nAnswer using the context above. If the context is insufficient for any part, say so explicitly rather than hallucinating.`
            : `You are Bumblebee, a helpful voice assistant. Answer the user's question using the retrieved context below. Plain text only, no markdown, TTS-friendly.\n\nContext:\n${plannedRAG.context}\n\nQuestion: ${routingQuery}`;

        const plannedAnswer = await obj.customQuery(synthesisPrompt);
        if (plannedAnswer?.trim() && !plannedAnswer.startsWith("Model error:")) {
            return finalize(plannedAnswer, "rag:planned", plannedRAG.chunks, "text");
        }
        // Planning loop found nothing useful — fall through to command routing
    }

    // --- Command routing ---
    let c = await checkCommands(routingQuery, obj);
    if (c.isCommand == true) {
        const commandResult = await handleCommand(c.cmd, c.params);
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
        let p = await resolvePluginIntent(routingQuery, obj);
        if (p.isPlugin == true) {
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