const fs = require("fs");
const { google } = require("googleapis");

function isEmail(value) {return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim())}
function normalizeText(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function toTokens(value) {
    return (!normalizeText(value)?[]:normalizeText(value).split(" ").filter(Boolean));
}

function parseHeaderAddresses(headerValue) {
    const out = [];
    const value = String(headerValue || "");
    if (!value.trim()) return out;

    const segments = value.split(",").map(s => s.trim()).filter(Boolean);
    for (const seg of segments) {
        const angle = seg.match(/^(.*)<([^>]+)>$/);
        if (angle) {
            const name = angle[1].replace(/^"|"$/g, "").trim();
            const email = angle[2].trim();
            if (isEmail(email)) out.push({ name, email });
            continue;
        }

        const singleEmail = seg.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
        if (singleEmail) {
            out.push({ name: "", email: singleEmail[0].trim() });
        }
    }

    return out;
}

function dedupeCandidates(candidates) {
    const seen = new Set();
    const out = [];

    for (const candidate of candidates) {
        const email = String(candidate.email || "").trim().toLowerCase();
        if (!email || seen.has(email)) continue;
        seen.add(email);
        out.push({
            name: candidate.name || "Unknown",
            email,
            score: Number(candidate.score || 0),
            source: candidate.source || "unknown"
        });
    }

    return out;
}

function formatCandidateOptions(candidates) {
    const sliced = candidates.slice(0, 5);
    return sliced.map((item, idx) => `${idx + 1}. ${item.name} <${item.email}>`).join("; ");
}

function selectCandidateFromInput(input, candidates) {
    const raw = String(input || "").trim();
    if (!raw) return null;

    const numeric = raw.match(/^(?:option\s*)?(\d{1,2})$/i);
    if (numeric) {
        const idx = Number(numeric[1]) - 1;
        if (idx >= 0 && idx < candidates.length) {
            return candidates[idx];
        }
    }
    //lmao
    const ordinalMap = {
        one: 1,
        first: 1,
        two: 2,
        second: 2,
        three: 3,
        third: 3,
        four: 4,
        fourth: 4,
        five: 5,
        fifth: 5
    };

    const normalizedWords = normalizeText(raw).replace(/^option\s+/, "").trim();
    if (Object.prototype.hasOwnProperty.call(ordinalMap, normalizedWords)) {
        const idx = ordinalMap[normalizedWords] - 1;
        if (idx >= 0 && idx < candidates.length) {
            return candidates[idx];
        }
    }

    if (isEmail(raw)) {
        const email = raw.toLowerCase();
        const matched = candidates.find(c => c.email.toLowerCase() === email);
        if (matched) return matched;
    }

    const normalizedRaw = normalizeText(raw);
    const matchedByName = candidates.find(c => normalizeText(c.name) === normalizedRaw);
    if (matchedByName) return matchedByName;

    return null;
}

function recipientMatchScore(query, name, email) {
    const q = normalizeText(query);
    const n = normalizeText(name);
    const e = String(email || "").toLowerCase();
    const local = e.split("@")[0] || "";
    if (!q) return 0;

    let score = 0;
    if (n === q) score = Math.max(score, 7);
    if (n && n.includes(q)) score = Math.max(score, 5);
    if (e === q) score = Math.max(score, 8);
    if (local === q.replace(/\s+/g, "")) score = Math.max(score, 6);
    if (local.includes(q.replace(/\s+/g, ""))) score = Math.max(score, 4);

    const qt = toTokens(q);
    const nt = new Set(toTokens(n));
    if (qt.length > 0 && nt.size > 0) {
        let hits = 0;
        for (const token of qt) {
            if (nt.has(token)) hits++;
        }

        const ratio = hits / qt.length;
        if (ratio >= 0.5) score = Math.max(score, 3 + ratio * 2);
    }

    return score;
}


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

function parseEmailDraftIntentFromInput(input) {
    //gotta figure out a better? way to do this. maybe use a llm in the future
    const raw = String(input || "").trim();
    if (!raw) return null;
    // Case 1: explicit message body present.
    const fullPattern = /(?:write|send|compose)\s+(?:an?\s+)?email\s+to\s+(.+?)\s+(?:regarding|about|subject\s*:?\s*)\s+(.+?)\s+(?:saying|body\s*:?\s*)\s+([\s\S]+)$/i;
    const fullMatch = raw.match(fullPattern);
    if (fullMatch) {
        const recipient = String(fullMatch[1] || "").trim();
        const subject = String(fullMatch[2] || "").trim().replace(/[.!?]+$/g, "");
        const body = String(fullMatch[3] || "").trim();
        if (recipient && subject) {
            return { recipient, subject, body: body || null };
        }
    }

    // Case 2: only recipient + subject-like phrase.
    const subjectPattern = /(?:write|send|compose)\s+(?:an?\s+)?email\s+to\s+(.+?)\s+(?:regarding|about|subject\s*:?\s*)\s+([\s\S]+)$/i;
    const subjectMatch = raw.match(subjectPattern);
    if (subjectMatch) {
        const recipient = String(subjectMatch[1] || "").trim();
        const subject = String(subjectMatch[2] || "").trim().replace(/[.!?]+$/g, "");
        if (recipient && subject) {
            return { recipient, subject, body: null };
        }
    }

    return null;
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

        this.people = google.people({
            version: "v1",
            auth: this.oAuth2Client
        });
    }

    async prefillWorkflowParams({ workflow, input, params }) {
        if (workflow !== "send_email") {
            return {};
        }

        const parsed = parseEmailDraftIntentFromInput(input || "");
        if (!parsed) {
            return {};
        }

        const next = {};
        if ((!params?.recipient || !String(params.recipient).trim()) && parsed.recipient) {
            next.recipient = parsed.recipient;
        }
        if ((!params?.subject || !String(params.subject).trim()) && parsed.subject) {
            next.subject = parsed.subject;
        }
        // Intentionally not filling body from vague statements like "regarding ..." so the assistant still asks for explicit body when needed.
        if ((!params?.body || !String(params.body).trim()) && parsed.body) {
            next.body = parsed.body;
        }

        return next;
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

    async sendEmailWorkflow(params, context = {}) {
        const recipientInput = String(params.recipient || "").trim();
        const subject = String(params.subject || "").trim();
        const body = String(params.body || "").trim();
        const cc = params.cc ? String(params.cc).trim() : "";
        const candidatePool = Array.isArray(params._recipientCandidates) ? params._recipientCandidates : [];

        if (!recipientInput || !subject || !body) {
            return {
                status: "needs_input",
                message: "Missing required parameters to send the email. Please provide recipient, subject, and body.",
                field: !recipientInput ? "recipient" : (!subject ? "subject" : "body")
            };
        }

        let recipientResolution;
        if (candidatePool.length > 0) {
            const selectionInput = String(context?.input || "").trim();
            const selected =
                selectCandidateFromInput(selectionInput, candidatePool) ||
                selectCandidateFromInput(recipientInput, candidatePool);
            if (!selected) {
                return {
                    status: "needs_input",
                    field: "recipient",
                    message: `Please choose recipient by option number or exact email. Options: ${formatCandidateOptions(candidatePool)}`
                };
            }

            recipientResolution = {
                ok: true,
                email: selected.email,
                name: selected.name,
                source: selected.source || "selection"
            };
        } else {
            recipientResolution = await this.resolveRecipient(recipientInput);
        }

        if (!recipientResolution.ok) {
            if (Array.isArray(recipientResolution.candidates) && recipientResolution.candidates.length > 0) {
                params._recipientCandidates = recipientResolution.candidates;
            }

            return {
                status: "needs_input",
                message: recipientResolution.message,
                field: "recipient"
            };
        }

        delete params._recipientCandidates;

        const recipient = recipientResolution.email;

        const lines = [
            `To: ${recipient}`,
            ...(cc ? [`Cc: ${cc}`] : []),
            "Content-Type: text/plain; charset=\"UTF-8\"",
            "MIME-Version: 1.0",
            `Subject: ${subject}`,
            "",
            body
        ];

        const message = lines.join("\n");
        const encodedMessage = Buffer.from(message)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");

        try {
            const sent = await this.gmail.users.messages.send({
                userId: "me",
                requestBody: {
                    raw: encodedMessage
                }
            });

            if (recipientResolution.source === "contacts" || recipientResolution.source === "history") {
                return `Email sent successfully to ${recipientResolution.name} <${recipient}>. Message id: ${sent.data.id}`;
            }

            return `Email sent successfully. Message id: ${sent.data.id}`;
        } catch (err) {
            const details = String(err?.message || "");
            const scopeError = details.includes("insufficient authentication scopes") || details.includes("insufficientPermissions");
            if (scopeError) {
                return "Failed to send email: OAuth token is missing Gmail send scope. Regenerate plugins/token.json using plugins/generate_token.js after adding/accepting https://www.googleapis.com/auth/gmail.send.";
            }
            return `Failed to send email: ${err.message}`;
        }
    }

    async resolveRecipient(recipientInput) {
        const direct = String(recipientInput || "").trim();
        if (!direct) {
            return {
                ok: false,
                message: "Please provide a recipient name or email address."
            };
        }

        if (isEmail(direct)) {
            return {
                ok: true,
                email: direct,
                source: "direct"
            };
        }

        const query = direct.toLowerCase();
        const matches = [];
        let pageToken = undefined;

        try {
            const searched = await this.people.people.searchContacts({
                query: direct,
                readMask: "names,emailAddresses",
                pageSize: 20
            });

            const searchedResults = searched?.data?.results || [];
            for (const item of searchedResults) {
                const person = item.person || {};
                const name = person.names?.[0]?.displayName || "Unknown";
                const emails = person.emailAddresses || [];

                for (const emailObj of emails) {
                    const email = String(emailObj.value || "").trim();
                    if (!email) continue;

                    const score = recipientMatchScore(query, name, email);
                    if (score <= 0) continue;

                    matches.push({ name, email, score, source: "contacts" });
                }
            }

            do {
                const res = await this.people.people.connections.list({
                    resourceName: "people/me",
                    pageSize: 500,
                    pageToken,
                    personFields: "names,emailAddresses"
                });

                const people = res.data.connections || [];
                for (const person of people) {
                    const names = person.names || [];
                    const emails = person.emailAddresses || [];
                    if (emails.length === 0) continue;

                    const primaryName = names[0]?.displayName || "Unknown";

                    for (const emailObj of emails) {
                        const email = String(emailObj.value || "").trim();
                        if (!email) continue;

                        const score = recipientMatchScore(query, primaryName, email);
                        if (score <= 0) continue;

                        matches.push({
                            name: primaryName,
                            email,
                            score,
                            source: "contacts"
                        });
                    }
                }

                pageToken = res.data.nextPageToken;
            } while (pageToken && matches.length < 10);
        } catch (err) {
            const details = String(err?.message || "");
            const scopeError = details.includes("insufficient authentication scopes") || details.includes("insufficientPermissions");
            if (scopeError) {
                return {
                    ok: false,
                    message: "Recipient lookup failed: token is missing Google Contacts scope. Regenerate plugins/token.json and accept https://www.googleapis.com/auth/contacts.readonly."
                };
            }

            return {
                ok: false,
                message: `Recipient lookup failed: ${details}`
            };
        }

        if (matches.length === 0) {
            const history = await this.findRecipientFromGmailHistory(direct);
            if (history.ok) {
                return history;
            }

            return {
                ok: false,
                message: `No contact found for \"${direct}\" in Google Contacts or recent Gmail headers. Please provide the full email address.`
            };
        }

        const uniqueMatches = dedupeCandidates(matches);
        uniqueMatches.sort((a, b) => b.score - a.score);
        if (uniqueMatches.length === 0) {
            return {
                ok: false,
                message: `No contact found for \"${direct}\" in Google Contacts or recent Gmail headers. Please provide the full email address.`
            };
        }

        const highConfidence = uniqueMatches.filter(item => item.score >= 7);
        if (highConfidence.length === 1 && uniqueMatches.length === 1 && highConfidence[0].source === "contacts") {
            return {
                ok: true,
                email: highConfidence[0].email,
                name: highConfidence[0].name,
                source: "contacts"
            };
        }

        const optionText = formatCandidateOptions(uniqueMatches);
        return {
            ok: false,
            candidates: uniqueMatches.slice(0, 5),
            message: `Multiple or fuzzy recipient matches for \"${direct}\". Choose one by number or provide exact email. Options: ${optionText}`
        };
    }

    async findRecipientFromGmailHistory(queryText) {
        const matches = [];

        try {
            const list = await this.gmail.users.messages.list({
                userId: "me",
                maxResults: 25
            });

            const messages = list.data.messages || [];
            for (const msg of messages) {
                const meta = await this.gmail.users.messages.get({
                    userId: "me",
                    id: msg.id,
                    format: "metadata",
                    metadataHeaders: ["From", "To", "Cc"]
                });

                const headers = meta?.data?.payload?.headers || [];
                for (const header of headers) {
                    const key = String(header.name || "").toLowerCase();
                    if (key !== "from" && key !== "to" && key !== "cc") continue;

                    const addresses = parseHeaderAddresses(header.value);
                    for (const addr of addresses) {
                        const score = recipientMatchScore(queryText, addr.name, addr.email);
                        if (score <= 0) continue;
                        matches.push({
                            name: addr.name || "Unknown",
                            email: addr.email,
                            score,
                            source: "history"
                        });
                    }
                }
            }
        } catch (err) {
            return {
                ok: false,
                message: `Recipient lookup in Gmail history failed: ${String(err?.message || err)}`
            };
        }

        if (matches.length === 0) {
            return {
                ok: false,
                message: "No match in Gmail history"
            };
        }

        const uniqueMatches = dedupeCandidates(matches);
        uniqueMatches.sort((a, b) => b.score - a.score);
        if (uniqueMatches.length === 0) {
            return {
                ok: false,
                message: "No match in Gmail history"
            };
        }

        const optionText = formatCandidateOptions(uniqueMatches);
        return {
            ok: false,
            candidates: uniqueMatches.slice(0, 5),
            message: `I found possible recipients from Gmail history for \"${queryText}\". Choose one by number or provide exact email. Options: ${optionText}`
        };
    }
}

module.exports = Gmail;
