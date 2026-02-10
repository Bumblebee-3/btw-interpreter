const fs = require("fs");
const { google } = require("googleapis");

class GoogleCalendar {
    constructor(credentials_path, token_path) {
        this.credentials = JSON.parse(
            fs.readFileSync(credentials_path)
        );
        this.tokenPath = token_path;

        const { client_secret, client_id, redirect_uris } =
            this.credentials.installed;

        this.oAuth2Client = new google.auth.OAuth2(
            client_id,
            client_secret,
            redirect_uris[0]
        );

        const token = JSON.parse(fs.readFileSync(token_path));
        this.oAuth2Client.setCredentials(token);

        this.calendar = google.calendar({
            version: "v3",
            auth: this.oAuth2Client
        });
    }
    async getUpcomingEvents(query) {
        const now = new Date();

        let timeMin = now;
        let timeMax = null;

        // default: next 365 days
        let days = 365;

        if (typeof query === "string") {
            const q = query.toLowerCase();

            // ---------- 1️⃣ relative days: "next 7 days", "in 14 days"
            let match = q.match(/\b(\d+)\s*days?\b/);
            if (match) {
                days = Number(match[1]);
            }

            // ---------- 2️⃣ relative months: "next 2 months", "in 3 months"
            match = q.match(/\b(\d+)\s*months?\b/);
            if (match) {
                days = Number(match[1]) * 30;
            }

            // ---------- 3️⃣ absolute month: "in august"
            const monthMap = {
                january: 0, february: 1, march: 2, april: 3,
                may: 4, june: 5, july: 6, august: 7,
                september: 8, october: 9, november: 10, december: 11
            };

            match = q.match(
                /\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/
            );

            if (match) {
                const monthIndex = monthMap[match[1]];
                let year = now.getFullYear();

                // if month already passed → next year
                if (monthIndex < now.getMonth()) {
                    year += 1;
                }

                timeMin = new Date(year, monthIndex, 1, 0, 0, 0);
                timeMax = new Date(year, monthIndex + 1, 0, 23, 59, 59);
            }
        }

        // ---------- fallback relative window
        if (!timeMax) {
            if (!Number.isFinite(days) || days <= 0) {
                days = 365;
            }

            timeMax = new Date(now);
            timeMax.setDate(timeMax.getDate() + days);
        }

        const res = await this.calendar.events.list({
            calendarId: "primary",
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
            singleEvents: true,
            orderBy: "startTime"
        });

        return res.data.items.map(e => ({
            summary: e.summary,
            start: e.start.dateTime || e.start.date
        }));
    }


}

module.exports = GoogleCalendar;
