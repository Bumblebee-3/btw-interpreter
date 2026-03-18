const {checkCommands , handleCommand} = require("./commandHandler.js");
const {checkPlugins , handlePlugin} = require("./pluginHandler.js");
const {handleWorkflowInput} = require("./workflowHandler.js");
const {answer} = require("./groq.js");
async function handle(query,obj){
    const workflowResult = await handleWorkflowInput(query, obj);
    if (workflowResult.handled) {
        return workflowResult.response;
    }

    let c = checkCommands(query,obj);
    if(c.isCommand==true){
        
        return await handleCommand(c.cmd);
    } else {
        let p= checkPlugins(query,obj);
        if(p.isPlugin==true){
            return await handlePlugin(p.plugin,p.function,query,obj.groq_api,obj);
        } else {
            return await answer(query,obj.groq_api,false,obj);
        }
    }
}

module.exports = {
    handle
}