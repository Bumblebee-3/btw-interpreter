const fs = require("fs");
const { google } = require("googleapis");
const { originalLog } = require("../../index.js");

class GoogleCalendar {
    constructor(credentials_path, token_path, obj) {
        this.credentials = JSON.parse(fs.readFileSync(credentials_path));
        this.obj = obj;
        const { client_secret, client_id, redirect_uris } =
        this.credentials.installed;
        this.oAuth2Client = new google.auth.OAuth2( client_id, client_secret, redirect_uris[0] );
        const token = JSON.parse(fs.readFileSync(token_path));
        this.oAuth2Client.setCredentials(token);
        this.calendar = google.calendar({version: "v3",auth: this.oAuth2Client});
    }


    async parseIntent(query) {
        const now = new Date().toISOString();

        const prompt = `
You convert natural language into Google Calendar query JSON.

Current time (ISO): ${now}

Return ONLY valid JSON.

Schema:
{
  "title_keywords": string[] | null,
  "time_min_iso": string | null,
  "time_max_iso": string | null,
  "limit": number,
  "include_all_calendars": boolean
}

Rules:
- Convert natural language time (tomorrow, next week, March, etc.) into ISO timestamps
- If no time specified, default to now → +30 days
- Default limit = 10
- Extract event title keywords if mentioned
`;

        const raw = await this.obj.customQuery(
            prompt + `\nUser request: "${query}"`
        );

        try {
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("No JSON found");

            return JSON.parse(jsonMatch[0]);
        } catch (err) {
            console.error("Calendar AI parse failed:", raw);

            const fallbackMin = new Date();
            const fallbackMax = new Date();
            fallbackMax.setDate(fallbackMax.getDate() + 30);

            return {
                title_keywords: null,
                time_min_iso: fallbackMin.toISOString(),
                time_max_iso: fallbackMax.toISOString(),
                limit: 10,
                include_all_calendars: true
            };
        }
    }


    async getUpcomingEvents(query) {
        const intent = await this.parseIntent(query);

        const now = new Date();


        const lowerQuery = query.toLowerCase();


        const wantsSingleFutureEvent =
        lowerQuery.includes("closest") ||
        lowerQuery.includes("next") ||
        lowerQuery.includes("upcoming") ||
        lowerQuery.includes("soon") ||
        lowerQuery.includes("imminent") ||
        lowerQuery.includes("nearest");

    if (wantsSingleFutureEvent) {
        const future = new Date();
        future.setFullYear(future.getFullYear() + 1);

        intent.time_min_iso = now.toISOString();
        intent.time_max_iso = future.toISOString();
        intent.limit = 1;
    }


        const timeMin = intent.time_min_iso
            ? new Date(intent.time_min_iso).toISOString()
            : now.toISOString();

        let timeMax;

        if (intent.time_max_iso) {
            timeMax = new Date(intent.time_max_iso).toISOString();
        } else {
            const fallback = new Date();
            fallback.setDate(fallback.getDate() + 30);
            timeMax = fallback.toISOString();
        }

        const limit = intent.limit || 10;


        const calendarList = await this.calendar.calendarList.list();

        const calendarsToSearch = intent.include_all_calendars
            ? calendarList.data.items
            : [calendarList.data.items[0]];


        const eventRequests = calendarsToSearch.map(cal =>
            this.calendar.events.list({
                calendarId: cal.id,
                timeMin,
                timeMax,
                singleEvents: true,
                orderBy: "startTime",
                maxResults: 50
            }).catch(() => ({ data: { items: [] } }))
        );

        const responses = await Promise.all(eventRequests);

        let allEvents = responses.flatMap((res, index) => {
            const calendarName = calendarsToSearch[index].summary;

            return (res.data.items || []).map(event => ({
                name: event.summary || "No Title",
                start: event.start.dateTime || event.start.date,
                calendar: calendarName
            }));
        });


        if (intent.title_keywords && intent.title_keywords.length) {
        const tokens = intent.title_keywords
            .flatMap(k => k.toLowerCase().split(/\s+/))
            .filter(Boolean);

        allEvents = allEvents.filter(event => {
            const name = event.name.toLowerCase();

            return tokens.some(token => name.includes(token));
        });
    }


        const sorted = allEvents.sort(
            (a, b) => new Date(a.start) - new Date(b.start)
        );

        const finalResults = sorted.slice(0, limit);
        return finalResults;
    }

}

module.exports = GoogleCalendar;
