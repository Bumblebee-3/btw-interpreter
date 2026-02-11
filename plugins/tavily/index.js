class Tavily {
    constructor(search_depth, country, tavily_api_key) {
        this.search_depth = search_depth;
        this.country = country;
        this.tavily_api_key = tavily_api_key;
    }

    async searchOnline(input) {
        try {
            const payload = {
                query: input,
                include_answer: "basic",
                search_depth: "advanced"
            };

            const response = await fetch("https://api.tavily.com/search", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.tavily_api_key}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                console.warn("HTTP error:", response.status);
                return "Tavily failed.";
            }

            const data = await response.json();

            return (
                data.answer ||
                data.results?.[0]?.content ||
                "Tavily failed."
            );

        } catch (err) {
            console.warn("Fetch error:", err);
            return "Tavily failed.";
        }
    }
}

module.exports = Tavily;
