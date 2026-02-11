let fs = require("fs");
let path = require("path");
const queryHandler = require("./interpretter/index.js");

class Interpretter {
    constructor(args){
        this.command = {};
        this.plugins = [];
        if(!args.groq_api_key) throw new Error("Please provide groq api key!");
        this.groq_api = args.groq_api_key;
    }

    loadCommands(location) {
        try {
            const resolvedPath = path.resolve(location);
            if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
                throw new Error(`Invalid file location or not a file: ${resolvedPath}`);
            }
            this.command.location = resolvedPath;
            this.command.data = require(resolvedPath);
            console.log('Commands loaded successfully');
        } catch (error) {
            console.error('Failed to load commands:', error.message);
            process.exit(1); 
        }
    }

    loadPlugins(location,params){
        try {
            if(location=="calendar"){location=__dirname+"/plugins/calendar/plugindata.json";location=location.replace("/src/","/")}
            else if(location=="gmail"){location=__dirname+"/plugins/gmail/plugindata.json";location=location.replace("/src/","/")}
            else if (location=="tavily"){location=__dirname+"/plugins/tavily/plugindata.json";location=location.replace("/src/","/")}
            else if(location=="weather"){location=__dirname+"/plugins/weather/plugindata.json";location=location.replace("/src/","/")}
            const resolvedPath = path.resolve(location);
            const dir = path.dirname(resolvedPath);
            if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
                throw new Error(`Invalid file location or not a file: ${resolvedPath}`);
            }
            const obj = {
                location:resolvedPath,
                data:require(resolvedPath),
                params:params
            }
            if (!obj.data.name) throw new Error(`Misconfigured plugin data file: ${resolvedPath}. Missing name!`);
            if (!obj.data.entrypoint) throw new Error(`Misconfigured plugin data file: ${resolvedPath}. Missing entrypoint!`);
            if (!fs.existsSync(path.resolve(dir+"/"+obj.data.entrypoint)) || !fs.statSync(path.resolve(dir+"/"+obj.data.entrypoint)).isFile()) {
                throw new Error(`Misconfigured plugin data file: ${resolvedPath}. Invalid entrypoint (${path.resolve(dir+"/"+obj.data.entrypoint)})`);
            }
            if (obj.data.plugin_params && Array.isArray(obj.data.plugin_params)) {
                for (let i = 0; i < obj.data.plugin_params.length; i++) {
                    const paramName = obj.data.plugin_params[i];
                    if (!(paramName in params)) throw new Error(`Mismatch: Missing required plugin parameter: ${paramName}`);
                }
            }

            if(obj.data.functions.length==0 || obj.data.functions==null){
                throw new Error(`Misconfigured plugin data file: ${resolvedPath}. There must be atleast one function that the interpretter can call!`);
            }
            for(let i=0;i<obj.data.functions.length;i++){
                if (!obj.data.functions[i].name) throw new Error(`Misconfigured plugin data file: ${resolvedPath}. Missing requires_LLM in function [${i}]!`);
                if(!obj.data.functions[i].output_format) throw new Error(`Misconfigured plugin data file: ${resolvedPath}. Missing output_format in function ${obj.data.functions[i].name}!`)
                
                if (obj.data.functions[i].requires_LLM==null) throw new Error(`Misconfigured plugin data file: ${resolvedPath}. Missing requires_LLM in function ${obj.data.functions[i].name}!`);

                if(obj.data.functions[i].keywords==null || obj.data.functions[i].keywords.length==0){
                    throw new Error(`Misconfigured plugin data file: ${resolvedPath}. There must be atleast one keyword to trigger the function!`);
                }
            }

            this.plugins.push(obj);
            console.log(`[Plugin] ${obj.data.name} loaded successfully.`);
        } catch (error) {
            console.error(`Failed to load Plugin [${this.plugins.length+1}]:`, error.message);
            process.exit(1);
        }
    }
    async query(input){
        return await queryHandler.handle(input,this);
    }
}

module.exports = {
    Interpretter
}