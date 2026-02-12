async function answer(query,gapi,cp=false,obj) {
    if(!obj.db.dbPath){
        var prompt;
        if (cp == false) prompt = "You are a helpful voice assistant named Bumblebee. Answer the user's question concisely in one or two sentences. Avoid markdown; output plain text only. This text is going to be parsed into a tts tool, so keep it easy to read. Here is the query: "+query;
        else prompt = query;
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
        return data.choices[0].message.content;
    } else {
        let answer = await obj.db.searchDB(query,10,obj.table_config);
        let string = "\n";
        for(i in answer){
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
        return data.choices[0].message.content;
    }
}


async function plugin_answer(query,gapi,func,data,ctx) {
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
    const res = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${gapi}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "groq/compound",
                messages: [
                    { role: "user", content: prompt }
                ]
            })
        }
    );
    const {originalLog}=require("../../index.js")
    const d = await res.json();
    try{
        return d.choices[0].message.content;
    } catch (error) {
        //originalLog("Error in plugin_answer: " + d.error.message);
        return d.error.message;
    }
}


module.exports = {answer,plugin_answer}