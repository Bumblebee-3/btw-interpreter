const path = require("path");
const {plugin_answer} = require("./groq.js");

function checkPlugins(query, obj) {
    const inp = query.toLowerCase();
    const plugins = obj.plugins;
    let best = {
        score: 0,
        plugin: null,
        function: null,
        isPlugin:false
    };
    for (const plugin of plugins) {
        for (const func of plugin.data.functions) {
            let score = 0;
            for (const keyword of func.keywords) {
                if (inp.includes(keyword.toLowerCase())) {
                    score++;
                }
            }
            if (score > best.score) {
                best.score = score;
                best.plugin = plugin;
                best.function = func;
                best.isPlugin = true;
            }
        }
    }
    if (best.score === 0) return {isPlugin:false};
    return best;
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

async function handlePlugin(plugin,func,query,gapi){
    const pluginInstance = loadPlugin(plugin, plugin.params);
    const result = await callPluginFunction(pluginInstance,func,query);
    if (func.requires_LLM==true){
        return await plugin_answer(query,gapi,func,result);
    }
    return result;
}

module.exports = {
    checkPlugins,
    handlePlugin
}