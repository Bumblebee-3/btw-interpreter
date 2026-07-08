const MessageHistory = require("./messageHistory.js");

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
    const res = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${gapi}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "user", content: prompt }
                ]
            })
        }
    );

    return await res.json();
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
            "You are Bumblebee, a helpful voice assistant. " +
            "Answer concisely in 1-2 sentences. " +
            "Plain text only. No markdown. " +
            "Output will be used for TTS, so keep it clear and easy to read. " +
            "Use retrieved knowledge below, prioritizing higher similarity scores. " +
            "Ignore it if irrelevant.\n" +
            "Retrieved Context:\n" +
            string + "\n" +
            "Query: " + query;

        const res = await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${gapi}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [
                        { role: "user", content: prompt }
                    ]
                })
            }
        );

        const data = await res.json();
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
        `You are a helpful voice assistant named Bumblebee. Answer the user's question concisely in one or two sentences.\n`+
        `Avoid markdown; output plain text only. This text is going to be parsed into a tts tool, so keep it easy to read.\n`+
        `Here is the query: ${query}\n`+
        `Answer using the provided data strictly. If no data exists, say that you can't find any data.\n`+
        `Here is the function description that provides the data:\n` +
        `${JSON.stringify(func, null, 2)}\n` +
        `Here is the data:\n` +
        `${JSON.stringify(data, null, 2)}\n\n`+
        `Please note: [IMPORTANT] If the user is asking for information about an email, provide the link to that email EXPlICITLY IN THE FORMAT(square brackets must engulf the link) "LINK:[https://mail.google.com/mail/u/0/?authuser=${(!ctx.email )?"0":ctx.email}#all/<THREAD_ID>]" at the end of the answer, where <THREAD_ID> is the threadId of the email. This is the only way to access the email, so if the user is asking about an email, you MUST provide this link.\n`+
        `THE EMAIL MUST BE EASILY READABLE BY TTS AGENTS, SO DO NOT SEND UNNECESSARY DATA AND ANSWER WITHIN 1-2 SENTENCES. Do not send timestamps, only dates is good enough.`;

    //console.log(prompt);
        const d = await callGroq(prompt, gapi);
    return extractGroqContent(d);
}


module.exports = {answer,plugin_answer,rewriteQuery}