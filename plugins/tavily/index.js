const { exec } = require('child_process');

class Tavily {
    constructor(search_depth, country, tavily_api_key) {
        this.search_depth = search_depth;
        this.country = country;
        this.tavily_api_key = tavily_api_key;
    }

    searchOnline(input) {
        return new Promise((resolve, reject) => {
            /*const payload = JSON.stringify({
                query: input,
                auto_parameters: false,
                search_depth: this.search_depth,
                chunks_per_source: 3,
                max_results: 1,
                time_range: null,
                start_date: null,
                end_date: null,
                include_answer: "basic",
                include_raw_content: false,
                include_images: false,
                include_image_descriptions: false,
                include_favicon: false,
                include_domains: [],
                exclude_domains: [],
                country: this.country,
                include_usage: false
            });*/

            const payload = JSON.stringify({
    query: input,
    include_answer: "basic",
    search_depth: "advanced"
});


            const cmd = `curl --silent --request POST \
                --url https://api.tavily.com/search \
                --header 'Authorization: Bearer ${this.tavily_api_key}' \
                --header 'Content-Type: application/json' \
                --data '${payload}'
            `;

            exec(cmd, (error, stdout, stderr) => {
                if (stderr) console.warn("curl stderr:", stderr);
                if (error) console.warn("curl error:", stderr);

                try {
                    const response = JSON.parse(stdout);
                    //console.log(response)
                    const result = {
                        query: input,
                        answer: response.answer || response.results?.[0]?.content || "Tavily failed."
                    };
                    resolve(result.answer);
                } catch (err) {
                    console.warn("curl error:", err);
                    const result = {
                        query: input,
                        answer: "Tavily failed.",
                        error: err
                    };
                    resolve(result.answer);
                }
            });
        });
    }
}

module.exports = Tavily
