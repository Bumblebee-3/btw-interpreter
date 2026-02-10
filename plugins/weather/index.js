class Weather {
    constructor(api_key, default_location = "auto") {
        this.api_key = api_key;
        this.default_location = default_location;
        this.baseUrl = "https://api.weatherapi.com/v1";
    }

    async getWeather(query) {
        let location = this.default_location;
        let days = 1;

        if (typeof query === "string") {
            const q = query.toLowerCase();

            // extract location: "weather in london"
            const locMatch = q.match(/\bin\s+([a-z\s]+)$/);
            if (locMatch) {
                location = locMatch[1].trim();
            }

            if (q.includes("tomorrow")) days = 2;
            if (q.includes("week")) days = 7;
        }

        const url = `${this.baseUrl}/forecast.json` +
            `?key=${this.api_key}` +
            `&q=${encodeURIComponent(location)}` +
            `&days=${days}` +
            `&aqi=no&alerts=no`;

        const res = await fetch(url);
        const data = await res.json();

        if (data.error) {
            return {
                location,
                error: data.error.message
            };
        }

        const current = data.current;
        const forecast = data.forecast?.forecastday || [];

        return {
            location: `${data.location.name}, ${data.location.country}`,
            current: {
                temperature_c: current.temp_c,
                condition: current.condition.text,
                humidity: current.humidity,
                wind_kph: current.wind_kph
            },
            forecast: forecast.map(day => ({
                date: day.date,
                max_c: day.day.maxtemp_c,
                min_c: day.day.mintemp_c,
                condition: day.day.condition.text,
                rain_chance: day.day.daily_chance_of_rain
            }))
        };
    }
}

module.exports = Weather;
