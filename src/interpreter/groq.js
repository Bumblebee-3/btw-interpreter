async function answer(query,gapi,cp=false) {
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