function providerConfig(apiConfig, modelConfig) {
    const config = { ...apiConfig };
    if (modelConfig && typeof modelConfig === "object") {
        Object.assign(config, modelConfig);
        config.models = apiConfig.models;
        if (modelConfig.api_key_env !== undefined) {
            config.api_key = modelConfig.api_key_env ? (process.env[modelConfig.api_key_env] || "") : "";
        }
    }
    return config;
}

function modelConfig(apiConfig, kind) {
    const configured = apiConfig?.models?.[kind];
    if (configured && typeof configured === "object") {
        return {
            model: configured.model,
            apiConfig: providerConfig(apiConfig, configured)
        };
    }
    return { model: configured, apiConfig };
}

function _buildRequest(prompt, model, apiConfig = {}) {
    const provider = apiConfig.provider || "groq";
    const baseUrl = String(apiConfig.base_url || "").replace(/\/$/, "");
    const headers = {
        "Content-Type": "application/json",
        ...(apiConfig.extra_headers || {})
    };
    let body;
    let url;

    if (provider === "anthropic") {
        url = `${baseUrl}/v1/messages`;
        if (apiConfig.api_key) headers["x-api-key"] = apiConfig.api_key;
        headers["anthropic-version"] = apiConfig.anthropic_version || "2023-06-01";
        if (Array.isArray(apiConfig.anthropic_beta) && apiConfig.anthropic_beta.length) {
            headers["anthropic-beta"] = apiConfig.anthropic_beta.join(",");
        }
        body = {
            model,
            max_tokens: 8192,
            messages: [{ role: "user", content: prompt }]
        };
    } else {
        url = `${baseUrl}/chat/completions`;
        if (apiConfig.api_key) headers.Authorization = `Bearer ${apiConfig.api_key}`;
        body = { model, messages: [{ role: "user", content: prompt }] };
    }

    return { url, headers, body };
}

function _extractContent(payload, provider = "groq") {
    if (payload?.error) {
        const error = payload.error;
        throw new Error(error.message || `The ${provider} provider rejected the request.`);
    }
    let content;
    if (provider === "anthropic") {
        content = payload?.content?.find(block => block?.type === "text")?.text;
    } else {
        content = payload?.choices?.[0]?.message?.content;
    }
    return typeof content === "string" && content.trim()
        ? content
        : "I could not generate a response right now. Please try again.";
}

async function callWithModel(prompt, model, apiConfig) {
    const request = _buildRequest(prompt, model, apiConfig);
    const res = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body)
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
        const message = payload?.error?.message || `${res.status} ${res.statusText}`;
        throw new Error(`${apiConfig.provider || "LLM"} request failed: ${message}`);
    }
    return payload;
}

async function callLLM(prompt, apiConfig) {
    const selected = modelConfig(apiConfig, "default");
    return await callWithModel(prompt, selected.model, selected.apiConfig);
}

async function callLLMSmall(prompt, apiConfig) {
    const selected = modelConfig(apiConfig, "small");
    return await callWithModel(prompt, selected.model, selected.apiConfig);
}

async function rewriteQuery(prompt, apiConfig) {
    const data = await callLLM(prompt, apiConfig);
    return _extractContent(data, apiConfig?.provider);
}

function addHistory(query, obj) {
    if (!obj?.messageHistory) return query;
    const history = obj.messageHistory.getAll();
    if (!history.length) return query;
    const context = history.map(turn =>
        `[Conversation history]\n` +
        `User (${turn.timestamp}): ${turn.userQuery}\n` +
        `Tool: ${turn.toolName || "none"}\n` +
        `Raw data: ${JSON.stringify(turn.rawToolData, null, 2).slice(0, 1200)}\n` +
        `Response: ${turn.llmFormattedResult.slice(0, 400)}\n` +
        `[End of history]\n`
    ).join("\n");
    return `${context}\nCurrent query: ${query}`;
}

async function answer(query, apiConfig, cp = false, obj, model) {
    query = addHistory(query, obj);
    let prompt;
    const workbench = obj?.workbench === true;
    if (cp || !obj.db.dbPath) {
        prompt = cp ? query : "You are a helpful voice assistant named Bumblebee. Answer the user's question concisely in one or two sentences. Avoid markdown; output plain text only. This text is going to be parsed into a tts tool, so keep it easy to read. Here is the query: " + query;
    } else {
        const results = await obj.db.searchDB(query, 10, obj.table_config);
        const context = results.map(item => `${item.text} (similarity score: ${item.similarity})`).join("\n");
        prompt = "You are Bumblebee, a helpful voice assistant made by Hridhuun Savant. Answer concisely in 1-2 sentences. Plain text only. No markdown. Output will be used for TTS, so keep it clear and easy to read. Use retrieved knowledge below, prioritizing higher similarity scores. Ignore it if irrelevant.\nRetrieved Context:\n" + context + "\nQuery: " + query;
    }
    if (workbench && !cp) {
        prompt = "You are operating in workbench mode. Provide complete, detailed responses. Do not truncate. Use markdown formatting including headers, code blocks, and lists where appropriate.\n\n" + query;
    }
    const selected = model ? { model, apiConfig } : modelConfig(apiConfig, "default");
    return _extractContent(await callWithModel(prompt, selected.model, selected.apiConfig), selected.apiConfig?.provider);
}

async function answerSmall(query, apiConfig, cp = false, obj) {
    query = addHistory(query, obj);
    const prompt = cp ? query : "You are a helpful voice assistant named Bumblebee. Answer the user's question concisely in one or two sentences. Avoid markdown; output plain text only. This text is going to be parsed into a tts tool, so keep it easy to read. Here is the query: " + query;
    return _extractContent(await callLLMSmall(prompt, apiConfig), modelConfig(apiConfig, "small").apiConfig?.provider);
}

async function plugin_answer(query, apiConfig, func, data, ctx) {
    query = addHistory(query, ctx);
    const workbench = ctx?.workbench === true;
    const prompt = workbench
        ? `You are operating in workbench mode. Provide a complete, detailed answer using markdown where useful.\nHere is the query: ${query}\nAnswer using the provided data strictly. If no data exists, say that you can't find any data.\nFunction description:\n${JSON.stringify(func, null, 2)}\nData:\n${JSON.stringify(data, null, 2)}`
        : `You are a helpful voice assistant named Bumblebee made by Hridhuun Savant. Answer the user's question concisely in one or two sentences.\nAvoid markdown; output plain text only. This text is going to be parsed into a tts tool, so keep it easy to read.\nHere is the query: ${query}\nAnswer using the provided data strictly. If no data exists, say that you can't find any data.\nHere is the function description that provides the data:\n${JSON.stringify(func, null, 2)}\nHere is the data:\n${JSON.stringify(data, null, 2)}\n\nPlease note: [IMPORTANT] If the user is asking for information about an email, provide the link to that email EXPlICITLY IN THE FORMAT(square brackets must engulf the link) "LINK:[https://mail.google.com/mail/u/1/?authuser=1#all/<THREAD_ID>]" at the end of the answer, where <THREAD_ID> is the threadId of the email. This is the only way to access the email, so if the user is asking about an email, you MUST provide this link.\nTHE EMAIL MUST BE EASILY READABLE BY TTS AGENTS, SO DO NOT SEND UNNECESSARY DATA AND ANSWER WITHIN 1-2 SENTENCES. Do not send timestamps, only dates is good enough.`;
    return _extractContent(await callLLM(prompt, apiConfig), apiConfig?.provider);
}

const extractContent = (payload, provider) => _extractContent(payload, provider);

module.exports = { answer, answerSmall, plugin_answer, rewriteQuery, callLLM, callLLMSmall, extractContent, _buildRequest };