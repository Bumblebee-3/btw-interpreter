let fs = require("fs");
let path = require("path");
const queryHandler = require("./interpreter/index.js");

const {answer,answerSmall} = require("./interpreter/llm.js");

const LLM_DEFAULTS = {
    groq: { base_url: "https://api.groq.com/openai/v1", api_key_env: "GROQ_API_KEY" },
    openai: { base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY" },
    anthropic: { base_url: "https://api.anthropic.com", api_key_env: "ANTHROPIC_API_KEY" },
    ollama: { base_url: "http://localhost:11434/v1", api_key_env: "" },
    lmstudio: { base_url: "http://localhost:1234/v1", api_key_env: "" },
    custom: { base_url: "", api_key_env: "" }
};

function resolveLlmConfig(config = {}) {
    const llm = config.llm || {};
    const legacyKey = config.groq_api_key || process.env.gapi || process.env.GAPI || process.env.groq_api_key || process.env.GROQ_API_KEY;

    if (!config.llm && legacyKey) {
        return {
            provider: "groq",
            base_url: LLM_DEFAULTS.groq.base_url,
            api_key: legacyKey,
            models: { default: "moonshotai/kimi-k2-instruct", small: "openai/gpt-oss-20b" },
            extra_headers: {}
        };
    }

    const provider = llm.provider || "groq";
    const defaults = LLM_DEFAULTS[provider] || LLM_DEFAULTS.custom;
    const api_key_env = llm.api_key_env ?? defaults.api_key_env;
    return {
        provider,
        base_url: llm.base_url || defaults.base_url,
        api_key: api_key_env ? (process.env[api_key_env] || "") : "",
        models: {
            default: llm.models?.default || "openai/gpt-oss-120b",
            small: llm.models?.small || "openai/gpt-oss-20b"
        },
        extra_headers: llm.extra_headers || {},
        anthropic_version: llm.anthropic_version || "2023-06-01",
        anthropic_beta: llm.anthropic_beta || []
    };
}

class Interpreter {
    constructor(args){
        this.command = {};
        this.plugins = [];
        this.workflowState = null;
        this.reminderManager = null;
        if (args.groq_api_key && !args.llm_config) {
            this.llm_config = {
                provider: "groq",
                base_url: "https://api.groq.com/openai/v1",
                api_key: args.groq_api_key,
                models: {
                    default: "moonshotai/kimi-k2-instruct",
                    small: "openai/gpt-oss-20b"
                },
                extra_headers: {}
            };
        } else if (args.llm_config) {
            const envVar = args.llm_config.api_key_env || "";
            this.llm_config = {
                ...args.llm_config,
                api_key: envVar ? (process.env[envVar] || args.llm_config.api_key || "") : (args.llm_config.api_key || "")
            };
        } else {
            throw new Error("Please provide llm_config or groq_api_key!");
        }
        this.db = {};
        this.table_config = {};
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

    loadPlugins(location,params,email="0"){
        this.email=email;
        try {
            if(location=="calendar"){location=__dirname+"/plugins/calendar/plugindata.json";location=location.replace("/src/","/");try{const { google } = require("googleapis");}catch(err){console.log("Please install googleapis via npm.");process.exit(0);}}
            else if(location=="gmail"){location=__dirname+"/plugins/gmail/plugindata.json";location=location.replace("/src/","/");try{const { google } = require("googleapis");}catch(err){console.log("Please install googleapis via npm.");process.exit(0);}}
            else if (location=="tavily"){location=__dirname+"/plugins/tavily/plugindata.json";location=location.replace("/src/","/")}
            else if(location=="weather"){location=__dirname+"/plugins/weather/plugindata.json";location=location.replace("/src/","/")}
            else if(location=="browser"){location=__dirname+"/plugins/browser/plugindata.json";location=location.replace("/src/","/")}
            else if(location=="whatsapp"){location=__dirname+"/plugins/whatsapp/plugindata.json";location=location.replace("/src/","/");try{const b = require("baileys");if(!b){throw new Error("missing");}}catch(err){console.log("Please install baileys via npm.");process.exit(0);}}
            else if(location=="reminder"){location=__dirname+"/plugins/reminder/plugindata.json";location=location.replace("/src/","/")}
            else if(location=="rag-manager"){location=__dirname+"/plugins/rag-manager/plugindata.json";location=location.replace("/src/","/")}
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
                    if (paramName === "obj") {
                        continue;
                    }
                    if (!(paramName in params)) throw new Error(`Mismatch: Missing required plugin parameter: ${paramName}`);
                }
            }

            if(obj.data.functions.length==0 || obj.data.functions==null){
                throw new Error(`Misconfigured plugin data file: ${resolvedPath}. There must be atleast one function that the interpreter can call!`);
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
    async processMessage(input, history, options = {}) {
        if (options.workbench) this.workbench = true;
        return await this.query(input);
    }
    loadDB(dbPath="lancedb",table_config){
        const LanceDBWrapper = require("./rag/LanceDBWrapper.js");
        const db = new LanceDBWrapper({
            dbPath: dbPath
        });
        this.db = db;
        this.table_config = table_config;
    }
    async addFileToTable(tableName, filePath, options = {}) {
        if (!this.db || typeof this.db.addFileToTable !== "function") {
            throw new Error("Database not initialized. Call loadDB() first.");
        }
        return await this.db.addFileToTable(tableName, filePath, options);
    }
    async addUrlToTable(tableName, url, options = {}) {
        if (!this.db || typeof this.db.addUrlToTable !== "function") {
            throw new Error("Database not initialized. Call loadDB() first.");
        }
        return await this.db.addUrlToTable(tableName, url, options);
    }
    async deleteBySource(tableName, source) {
        if (!this.db || typeof this.db.deleteBySource !== "function") {
            throw new Error("Database not initialized. Call loadDB() first.");
        }
        return await this.db.deleteBySource(tableName, source);
    }
    initReminderSystem(options = {}){
        const ReminderManager = require("./reminders/ReminderManager.js");
        this.reminderManager = new ReminderManager(options);
        this.reminderManager.start();
    }
    async customQuery(query,model){
        return await answer(query,this.llm_config,true,this,model);
    }
    async customSmallQuery(query){
        return await answerSmall(query,this.llm_config,true,this);
    }

}

module.exports = {
    Interpreter,
    resolveLlmConfig
}