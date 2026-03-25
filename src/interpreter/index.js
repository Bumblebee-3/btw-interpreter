const {checkCommands , handleCommand} = require("./commandHandler.js");
const {resolvePluginIntent , handlePlugin, handlePluginFollowUp} = require("./pluginHandler.js");
const {handleWorkflowInput} = require("./workflowHandler.js");
const {answer} = require("./groq.js");
async function handle(query,obj){
    obj.previousUserQuery = obj.lastUserQuery || "";
    obj.lastUserQuery = query;

    const workflowResult = await handleWorkflowInput(query, obj);
    if (workflowResult.handled) {
        return workflowResult.response;
    }

    const pluginFollowUp = await handlePluginFollowUp(query, obj);
    if (pluginFollowUp.handled) {
        return pluginFollowUp.response;
    }

    const effectiveQuery = (pluginFollowUp && typeof pluginFollowUp.rewrittenQuery === "string" && pluginFollowUp.rewrittenQuery.trim())
        ? pluginFollowUp.rewrittenQuery.trim()
        : query;

    let c = checkCommands(effectiveQuery,obj);
    if(c.isCommand==true){
        
        return await handleCommand(c.cmd);
    } else {
        let p= await resolvePluginIntent(effectiveQuery,obj);
        if(p.isPlugin==true){
            return await handlePlugin(p.plugin,p.function,effectiveQuery,obj.groq_api,obj);
        } else {
            return await answer(effectiveQuery,obj.groq_api,false,obj);
        }
    }
}

module.exports = {
    handle
}