const {checkCommands , handleCommand} = require("./commandHandler.js");
const {checkPlugins , handlePlugin} = require("./pluginHandler.js");
const {answer} = require("./groq.js");
async function handle(query,obj){
    let c = checkCommands(query,obj);
    if(c.isCommand==true){
        await handleCommand(c.cmd);
        return "Command was handled appropriately.";
    } else {
        let p= checkPlugins(query,obj);
        if(p.isPlugin==true){
            return await handlePlugin(p.plugin,p.function,query,obj.groq_api);
        } else {
            return await answer(query,obj.groq_api,false);
        }
    }
}

module.exports = {
    handle
}