const MessageHistory = require("./messageHistory.js");

const DEFAULT_CONFIG = {
    baseUrl: "http://127.0.0.1:1234",
    fallbackModel: "qwen/qwen3-4b",
    contextLength: 12817,
    evaluationBatchSize: 1048576,
    reasoning: "off"
};

let localConfig = {...DEFAULT_CONFIG};
let activeModel = null;
let modelReady = null;

function configureLocalInference(config = {}) {
    localConfig = {
        ...DEFAULT_CONFIG,
        ...config,
        baseUrl: String(config.baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/$/, "")
    };
    activeModel = null;
    modelReady = null;
}

function modelKey(model, instance) {
    if (typeof instance === "string" && instance.trim()) return instance;
    if (instance && typeof instance === "object") {
        for (const key of ["id", "model", "key"]) {
            if (typeof instance[key] === "string" && instance[key].trim()) return instance[key];
        }
    }
    return model?.key || model?.id || null;
}

async function ensureLocalModel() {
    if (activeModel) return activeModel;
    if (modelReady) return modelReady;

    modelReady = (async () => {
        const modelsResponse = await fetch(`${localConfig.baseUrl}/api/v1/models`);
        if (!modelsResponse.ok) {
            throw new Error(`LM Studio model list failed (${modelsResponse.status})`);
        }
        const payload = await modelsResponse.json();
        const models = Array.isArray(payload.models) ? payload.models : [];
        const loaded = models.find(model =>
            model?.type === "llm" && Array.isArray(model.loaded_instances) && model.loaded_instances.length > 0
        );

        if (loaded) {
            activeModel = loaded.key || loaded.id || modelKey(loaded, loaded.loaded_instances[0]);
            if (activeModel) return activeModel;
        }

        const fallback = models.find(model => model?.type === "llm" && modelKey(model) === localConfig.fallbackModel);
        if (!fallback) {
            throw new Error(`Fallback model is not available in LM Studio: ${localConfig.fallbackModel}`);
        }

        const loadResponse = await fetch(`${localConfig.baseUrl}/api/v1/models/load`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                model: localConfig.fallbackModel,
                context_length: localConfig.contextLength,
                eval_batch_size: localConfig.evaluationBatchSize,
                offload_kv_cache_to_gpu: true
            })
        });
        if (!loadResponse.ok) {
            const errorText = await loadResponse.text();
            throw new Error(`LM Studio model load failed (${loadResponse.status}): ${errorText}`);
        }

        activeModel = localConfig.fallbackModel;
        return activeModel;
    })();

    try {
        return await modelReady;
    } catch (error) {
        modelReady = null;
        throw error;
    }
}

function extractGroqContent(payload) {
    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    const first = choices[0];
    const content = first?.message?.content;
    if (typeof content === "string" && content.trim()) {
        return content;
    }

    const err = payload?.error?.message;
    if (typeof err === "string" && err.trim()) {
        return `Model error: ${err}`;
    }

    return "I could not generate a response right now. Please try again.";
}

async function callGroq(prompt, gapi) {
    const res = await fetch(`${localConfig.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            model: await ensureLocalModel(),
            reasoning_effort: localConfig.reasoning,
            messages: [{role: "user", content: prompt}]
        })
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data?.error?.message || `LM Studio inference failed (${res.status})`);
    }
    return data;
}

async function rewriteQuery(prompt, gapi) {
    const data = await callGroq(prompt, gapi);
    return extractGroqContent(data);
}


async function answer(query,gapi,cp=false,obj) {
    // Inject history context into the prompt if available
    if (obj?.messageHistory) {
        const history = obj.messageHistory.getAll();
        if (history.length > 0) {
            const historyContext = history.map(turn => 
                `[Conversation history]\n` +
                `User (${turn.timestamp}): ${turn.userQuery}\n` +
                `Tool: ${turn.toolName || 'none'}\n` +
                `Raw data: ${JSON.stringify(turn.rawToolData, null, 2).slice(0, 1200)}\n` +
                `Response: ${turn.llmFormattedResult.slice(0, 400)}\n` +
                `[End of history]\n`
            ).join("\n");
            
            query = `${historyContext}\nCurrent query: ${query}`;
        }
    }

    if(!obj.db.dbPath){
        var prompt;
        if (cp == false) prompt = "You are a helpful voice assistant named Bumblebee. Answer the user's question concisely in one or two sentences. Avoid markdown; output plain text only. This text is going to be parsed into a tts tool, so keep it easy to read. Here is the query: "+query;
        else prompt = query;
        const data = await callGroq(prompt, gapi);
        return extractGroqContent(data);
    } else {
        let answer = await obj.db.searchDB(query,10,obj.table_config);
        let string = "\n";
        for (const i in answer) {
            string += `${answer[i].text} (similarity score: ${answer[i].similarity})\n`
        }
        //console.log(string);
        const prompt =
            "You are Bumblebee, a helpful voice assistant made by Hridhuun Savant. " +
            "Answer concisely in 1-2 sentences. " +
            "Plain text only. No markdown. " +
            "Output will be used for TTS, so keep it clear and easy to read. " +
            "Use retrieved knowledge below, prioritizing higher similarity scores. " +
            "Ignore it if irrelevant.\n" +
            "Retrieved Context:\n" +
            string + "\n" +
            "Query: " + query;

        const data = await callGroq(prompt, gapi);
        return extractGroqContent(data);
    }
}


async function plugin_answer(query,gapi,func,data,ctx) {
    // Inject history context into the prompt if available
    if (ctx?.messageHistory) {
        const history = ctx.messageHistory.getAll();
        if (history.length > 0) {
            const historyContext = history.map(turn => 
                `[Conversation history]\n` +
                `User (${turn.timestamp}): ${turn.userQuery}\n` +
                `Tool: ${turn.toolName || 'none'}\n` +
                `Raw data: ${JSON.stringify(turn.rawToolData, null, 2).slice(0, 1200)}\n` +
                `Response: ${turn.llmFormattedResult.slice(0, 400)}\n` +
                `[End of history]\n`
            ).join("\n");
            
            query = `${historyContext}\nCurrent query: ${query}`;
        }
    }

    const prompt = 
        `You are a helpful voice assistant named Bumblebee made by Hridhuun Savant. Answer the user's question concisely in one or two sentences.\n`+
        `Avoid markdown; output plain text only. This text is going to be parsed into a tts tool, so keep it easy to read.\n`+
        `Here is the query: ${query}\n`+
        `Answer using the provided data strictly. If no data exists, say that you can't find any data.\n`+
        `Here is the function description that provides the data:\n` +
        `${JSON.stringify(func, null, 2)}\n` +
        `Here is the data:\n` +
        `${JSON.stringify(data, null, 2)}\n\n`+
        `Please note: [IMPORTANT] If the user is asking for information about an email, provide the link to that email EXPlICITLY IN THE FORMAT(square brackets must engulf the link) "LINK:[https://mail.google.com/mail/u/1/?authuser=1#all/<THREAD_ID>]" at the end of the answer, where <THREAD_ID> is the threadId of the email. This is the only way to access the email, so if the user is asking about an email, you MUST provide this link.\n`+
        `THE EMAIL MUST BE EASILY READABLE BY TTS AGENTS, SO DO NOT SEND UNNECESSARY DATA AND ANSWER WITHIN 1-2 SENTENCES. Do not send timestamps, only dates is good enough.`;//${(!ctx.email )?"1":ctx.email}

    //console.log(prompt);
        const d = await callGroq(prompt, gapi);
    return extractGroqContent(d);
}


module.exports = {answer,plugin_answer,rewriteQuery,configureLocalInference}