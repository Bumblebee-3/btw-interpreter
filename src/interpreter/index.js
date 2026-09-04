const {checkCommands , handleCommand} = require("./commandHandler.js");
const {resolvePluginIntent , handlePlugin, handlePluginFollowUp} = require("./pluginHandler.js");
const {handleWorkflowInput} = require("./workflowHandler.js");
const {answer, rewriteQuery} = require("./groq.js");
const R = require("./response.js");
const MessageHistory = require("./messageHistory.js");
const {buildRewritePrompt, finalizeRewrite, shouldRewriteQuery} = require("./queryRewrite.js");

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
            const rewrittenQuery = await rewriteQuery(rewritePrompt, obj.groq_api);
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

    let c = await checkCommands(routingQuery,obj);
    //console.log(c);
    if(c.isCommand==true){
        const commandResult = await handleCommand(c.cmd,c.params);
        return finalize(commandResult, `command:${c.cmd.id}`, commandResult, "text");
    } else {
        let p= await resolvePluginIntent(routingQuery,obj);
        if(p.isPlugin==true){
            const pluginResult = await handlePlugin(p.plugin, p.function, routingQuery, obj.groq_api, obj);
            return finalize(pluginResult, `${p.plugin.data.name}.${p.function.name}`, pluginResult, "text");
        } else {
            // Plain LLM fallback
            const llmResponse = await answer(routingQuery, obj.groq_api, false, obj);
            return finalize(llmResponse, null, null, "text");
        }
    }
}

module.exports = {
    handle
}
