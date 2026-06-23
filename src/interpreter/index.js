const {checkCommands , handleCommand} = require("./commandHandler.js");
const {resolvePluginIntent , handlePlugin, handlePluginFollowUp} = require("./pluginHandler.js");
const {handleWorkflowInput} = require("./workflowHandler.js");
const {answer} = require("./groq.js");
const R = require("./response.js");

async function handle(query,obj){
    obj.previousUserQuery = obj.lastUserQuery || "";
    obj.lastUserQuery = query;

    const finalize = (response) => {
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
        obj.lastAssistantResponse = response;
        global.__btwLastAssistantResponse = response;
        return response;
    };

    const workflowResult = await handleWorkflowInput(query, obj);
    if (workflowResult.handled) {
        return finalize(workflowResult.response);
    }

    const pluginFollowUp = await handlePluginFollowUp(query, obj);
    if (pluginFollowUp.handled) {
        return finalize(pluginFollowUp.response);
    }

    const effectiveQuery = (pluginFollowUp && typeof pluginFollowUp.rewrittenQuery === "string" && pluginFollowUp.rewrittenQuery.trim())
        ? pluginFollowUp.rewrittenQuery.trim()
        : query;

    let c = checkCommands(effectiveQuery,obj);
    if(c.isCommand==true){
        
        return finalize(await handleCommand(c.cmd));
    } else {
        let p= await resolvePluginIntent(effectiveQuery,obj);
        if(p.isPlugin==true){
            return finalize(await handlePlugin(p.plugin,p.function,effectiveQuery,obj.groq_api,obj));
        } else {
            return finalize(await answer(effectiveQuery,obj.groq_api,false,obj));
        }
    }
}

module.exports = {
    handle
}
