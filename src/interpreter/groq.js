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
        let answer = await obj.db.searchDB(query,10);
        let string = "\n";
        for(i in answer){
            string += `${answer[i].text} (similarity score: ${answer[i].similarity})\n`
        }
        const prompt =
            "You are Bumblebee, a helpful voice assistant. " +
            "Answer concisely in 2-3 sentences. " +
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


async function plugin_answer(query,gapi,func,data) {
    const prompt = 
        `You are a helpful voice assistant named Bumblebee. Answer the user's question concisely in one or two sentences.\n`+
        `Avoid markdown; output plain text only. This text is going to be parsed into a tts tool, so keep it easy to read.\n`+
        `Here is the query: ${query}\n`+
        `Answer using the provided data strictly. If no data exists, say that you can't find any data.\n`+
        `Here is the function description that provides the data:\n` +
        `${JSON.stringify(func, null, 2)}\n` +
        `Here is the data:\n` +
        `${JSON.stringify(data, null, 2)}`;

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
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "user", content: prompt }
                ]
            })
        }
    );

    const d = await res.json();
    //console.log(d);
    return d.choices[0].message.content;
}


module.exports = {answer,plugin_answer}