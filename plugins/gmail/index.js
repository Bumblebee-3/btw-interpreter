const fs = require("fs");
const { google } = require("googleapis");

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

class Gmail {
    constructor(credentials_path, token_path) {
        this.credentials = JSON.parse(
            fs.readFileSync(credentials_path)
        );

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

    async getEmails(query) {
        let maxResults = 25;
        let searchQuery = "";
        const DEFAULT_SCOPE = "in:inbox category:primary";

        if (!query || typeof query !== "string") {
            searchQuery = DEFAULT_SCOPE;
            maxResults = 1;
        } else {
            const trimmed = query.trim();

            const gmailOperatorRegex =
                /\b(from:|to:|subject:|in:|category:|is:|newer_than:|older_than:|has:|label:)/i;

            const isGmailSyntax = gmailOperatorRegex.test(trimmed);

            if (isGmailSyntax) {
                searchQuery = trimmed;
            } else {
                const q = trimmed.toLowerCase();
                searchQuery = DEFAULT_SCOPE + " ";

                if (q.includes("latest") || q.includes("last")||q.includes("most recent")||q.includes("newest")) {
                    maxResults = 1;
                }

                const numberMatch = q.match(/\b(\d+)\s+emails?\b/);
                if (numberMatch) {
                    maxResults = Math.min(Number(numberMatch[1]), 100);
                }

                if (q.includes("unread")) {
                    searchQuery += "is:unread ";
                }

                const fromMatch = q.match(/\bfrom\s+([a-z0-9@._-]+)\b/);
                if (fromMatch) {
                    searchQuery += `from:${fromMatch[1]} `;
                }

                if (q.includes("today")) {
                    searchQuery += "newer_than:1d ";
                }

                if (q.includes("this week")) {
                    searchQuery += "newer_than:7d ";
                }

                const handled =
                    q.includes("latest") ||
                    q.includes("last") ||
                    q.includes("unread") ||
                    q.includes("today") ||
                    q.includes("this week") ||
                    fromMatch ||
                    numberMatch;

                if (!handled) {
                    const cleaned = trimmed
                        .replace(/can you find/i, "")
                        .replace(/find/i, "")
                        .replace(/the email/i, "")
                        .replace(/regarding/i, "")
                        .replace(/about/i, "")
                        .replace(/with subject/i, "")
                        .replace(/subject/i, "")
                        .replace(/email/i, "")
                        .replace(/search/i, "")
                        .replace(/search for/i, "")
                        .replace(/\?/g, "")
                        .replace(/\./i,"")
                        .trim();
                    const {originalLog}=require("../../index.js");
                    //originalLog("Cleaned subject search query:", cleaned);
                    searchQuery += `${cleaned} `;
                }
            }
        }

        let messages = [];
        let pageToken = null;

        while (messages.length < maxResults) {
            const res = await this.gmail.users.messages.list({
                userId: "me",
                q: searchQuery.trim(),
                maxResults: Math.min(50, maxResults - messages.length),
                pageToken
            });

            if (!res.data.messages) break;

            messages.push(...res.data.messages);
            pageToken = res.data.nextPageToken;

            if (!pageToken) break;
        }

        const emails = [];
        const MAX_EMAILS_FOR_LLM = 5;
        const MAX_BODY_CHARS = 800;

        for (const msg of messages.slice(0, MAX_EMAILS_FOR_LLM)) {
            const full = await this.gmail.users.messages.get({
                userId: "me",
                id: msg.id,
                format: "full"
            });

            const payload = full.data.payload;
            const headers = payload.headers || [];

            const getHeader = name =>
                headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

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
            query: searchQuery.trim(),
            emails
        };
    }

}

module.exports = Gmail;
