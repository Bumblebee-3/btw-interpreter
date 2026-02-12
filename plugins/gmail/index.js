const fs = require("fs");
const { google } = require("googleapis");
const { originalLog } = require("../../index.js");


function decodeBase64(data) {
    if (!data) return "";
    const fixed = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(fixed, "base64").toString("utf-8");
}

function stripHtml(html) {
    if (!html) return "";
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function extractBody(payload) {
    if (!payload) return "";

    if (payload.body?.data) return decodeBase64(payload.body.data);

    if (!payload.parts) return "";

    for (const part of payload.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
            return decodeBase64(part.body.data);
        }
    }

    for (const part of payload.parts) {
        if (part.mimeType === "text/html" && part.body?.data) {
            return decodeBase64(part.body.data);
        }
    }

    return "";
}

function buildGmailQuery(intent) {
    let q = "";

    if (!intent.include_spam_trash) {
        q += "in:inbox ";
    }

    if (intent.sender) {
        const cleaned = intent.sender.replace(/"/g, "");
        q += `from:${cleaned} `;
    }

    if (intent.subject) {
        q += `subject:"${intent.subject.replace(/"/g, "")}" `;
    }

    if (intent.keywords && Array.isArray(intent.keywords)) {
        for (const word of intent.keywords) {
            q += `"${word.replace(/"/g, "")}" `;
        }
    }

    if (intent.has_attachment) {
        q += "has:attachment ";
    }

    if (intent.filename) {
        q += `filename:${intent.filename.replace(/"/g, "")} `;
    }

    if (intent.unread) {
        q += "is:unread ";
    }

    if (intent.timeframe_days) {
        q += `newer_than:${intent.timeframe_days}d `;
    }

    return q.trim();
}


class Gmail {
    constructor(credentials_path, token_path, obj) {
        this.credentials = JSON.parse(fs.readFileSync(credentials_path));
        this.obj = obj;

        const { client_secret, client_id, redirect_uris } =
            this.credentials.installed;

        this.oAuth2Client = new google.auth.OAuth2(
            client_id,
            client_secret,
            redirect_uris[0]
        );

        const token = JSON.parse(fs.readFileSync(token_path));
        this.oAuth2Client.setCredentials(token);

        this.gmail = google.gmail({
            version: "v1",
            auth: this.oAuth2Client
        });
    }


    async parseIntent(query) {
        const prompt = `
You are a Gmail query compiler.

Return ONLY valid JSON.
No explanation.
No markdown.
No extra text.

Schema:
{
  "sender": string | null,
  "subject": string | null,
  "keywords": string[] | null,
  "has_attachment": boolean,
  "filename": string | null,
  "unread": boolean,
  "timeframe_days": number | null,
  "limit": number,
  "include_spam_trash": boolean
}

Rules:
- "latest" or "most recent" => limit = 1
- If a number of emails is requested, use that number
- If nothing specified, limit = 5
- Extract important keywords if no sender specified
- If user mentions attachment, set has_attachment = true
- timeframe_days must be a number (1, 7, 30) or null
- If user mentions spam or trash, set include_spam_trash = true

User request:
"${query}"
`;

        let raw = await this.obj.customQuery(prompt);

        try {
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("No JSON found");

            return JSON.parse(jsonMatch[0]);
        } catch (err) {

            return {
                sender: null,
                subject: null,
                keywords: null,
                has_attachment: false,
                filename: null,
                unread: false,
                timeframe_days: null,
                limit: 5,
                include_spam_trash: false
            };
        }
    }

    async getEmails(query) {
        const intent = await this.parseIntent(query);

        const searchQuery = buildGmailQuery(intent);

        const maxResults = intent.limit || 5;

        let res = await this.gmail.users.messages.list({
            userId: "me",
            q: searchQuery,
            maxResults,
            includeSpamTrash: intent.include_spam_trash || false
        });

        let messages = res.data.messages || [];

        if (messages.length === 0 && searchQuery.includes("in:inbox")) {
            const relaxedQuery = searchQuery.replace("in:inbox", "").trim();

            const retry = await this.gmail.users.messages.list({
                userId: "me",
                q: relaxedQuery,
                maxResults,
                includeSpamTrash: intent.include_spam_trash || false
            });

            messages = retry.data.messages || [];
        }

        const emails = [];
        const MAX_BODY_CHARS = 800;

        for (const msg of messages) {
            const full = await this.gmail.users.messages.get({
                userId: "me",
                id: msg.id,
                format: "full"
            });

            const payload = full.data.payload;
            const headers = payload.headers || [];

            const getHeader = name =>
                headers.find(
                    h => h.name.toLowerCase() === name.toLowerCase()
                )?.value || "";

            let body = extractBody(payload);
            body = stripHtml(body).slice(0, MAX_BODY_CHARS);

            emails.push({
                threadId: full.data.threadId,
                from: getHeader("From"),
                to: getHeader("To"),
                subject: getHeader("Subject"),
                date: getHeader("Date"),
                snippet: full.data.snippet,
                body
            });
        }

        return {
            count: emails.length,
            query: searchQuery,
            intent,
            emails
        };
    }
}

module.exports = Gmail;
