const {checkCommands , handleCommand} = require("./commandHandler.js");
const {resolvePluginIntent , handlePlugin, handlePluginFollowUp} = require("./pluginHandler.js");
const {handleWorkflowInput} = require("./workflowHandler.js");
const {answer, plugin_answer, rewriteQuery} = require("./groq.js");
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

    if (shouldRewriteQuery(query, historySnapshot, obj.workflowState)) {
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
                response = R.rich(content, [{ label: "Open", type: "open_url", value: url }]);
            } else {
                response = R.text(response);
            }
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

    let c = checkCommands(routingQuery,obj);
    if(c.isCommand==true){
        const commandResult = await handleCommand(c.cmd);
        return finalize(commandResult, `command:${c.cmd.id}`, commandResult, "text");
    } else {
        let p= await resolvePluginIntent(routingQuery,obj);
        if(p.isPlugin==true){
            // For plugins that don't require LLM - we need to capture the raw plugin result
            if (p.function && p.function.requires_LLM === false) {
                const pluginResult = await handlePlugin(p.plugin, p.function, routingQuery, obj.groq_api, obj);
                return finalize(pluginResult, `${p.plugin.data.name}.${p.function.name}`, pluginResult, "text");
            } else {
                // For plugins that require LLM - we need to capture the raw plugin result before LLM processing
                const pluginResult = await handlePlugin(p.plugin, p.function, routingQuery, obj.groq_api, obj);
                const llmResponse = await plugin_answer(routingQuery, obj.groq_api, p.function, pluginResult, obj);
                return finalize(llmResponse, `${p.plugin.data.name}.${p.function.name}`, pluginResult, "text");
            }
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
