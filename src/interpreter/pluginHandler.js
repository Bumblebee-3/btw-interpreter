const path = require("path");
const {answer,plugin_answer} = require("./groq.js");

function checkPlugins(query, obj) {
    const inp = query.toLowerCase();
    const plugins = obj.plugins;
    let best = {
        score: 0,
        specificity: 0,
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
                    // Longer phrases are usually more intentional than single generic words.
                    score += Math.max(1, tokenCount);
                    specificity += normalizedKeyword.length;
                }
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

module.exports = {
    checkPlugins,
    handlePlugin,
    loadPlugin,
    callPluginFunction
}