const fs = require("fs");
const path = require("path");
const baileys = require("baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");

if (!global.__btwLibsignalNoiseFilterInstalled) {
  global.__btwLibsignalNoiseFilterInstalled = true;

  const noisyPrefixes = [
    "Closing session:",
    "Opening session:",
    "Removing old closed session:",
    "Session already closed",
    "Session already open",
    "Migrating session to:"
  ];

  const shouldDrop = args => {
    if (!Array.isArray(args) || args.length === 0) return false;
    const first = typeof args[0] === "string" ? args[0] : "";
    return noisyPrefixes.some(prefix => first.startsWith(prefix));
  };

  const originalInfo = console.info.bind(console);
  const originalWarn = console.warn.bind(console);

  console.info = (...args) => {
    if (shouldDrop(args)) return;
    originalInfo(...args);
  };

  console.warn = (...args) => {
    if (shouldDrop(args)) return;
    originalWarn(...args);
  };
}

const makeWASocket = baileys.default || baileys.makeWASocket;
const useMultiFileAuthState = baileys.useMultiFileAuthState;
const fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
const DisconnectReason = baileys.DisconnectReason || {};

let singleton = {
  socket: null,
  connecting: null,
  connectionState: "closed",
  lastError: "",
  lastQr: "",
  authPath: "",
  chats: new Map(),
  messages: new Map(),
  maxStoredMessages: 50,
  historyBootstrapDone: false
};

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPhoneLike(value) {
  return /\+?[0-9][0-9\s\-()]{6,}/.test(String(value || ""));
}

function toDigits(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function phoneToJid(value, defaultCountryCode = "") {
  const raw = String(value || "").trim();
  let digits = toDigits(raw);
  if (!digits) return "";

  const hasPlus = raw.startsWith("+");
  if (!hasPlus && defaultCountryCode) {
    const dcc = toDigits(defaultCountryCode);
    if (dcc && !digits.startsWith(dcc)) {
      digits = dcc + digits;
    }
  }

  return `${digits}@s.whatsapp.net`;
}

function extractMessageText(message) {
  if (!message) return "";
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  return "";
}

function ingestMessageToHistory(msg) {
  const jid = msg?.key?.remoteJid;
  if (!jid) return;

  const text = extractMessageText(msg.message);
  if (!text || !String(text).trim()) return;

  const id = String(msg?.key?.id || "").trim();
  const sender = msg.pushName || msg.key.participant || msg.key.remoteJid || "unknown";
  const timestampRaw = msg.messageTimestamp;
  const timestamp = timestampRaw ? Number(timestampRaw) : Math.floor(Date.now() / 1000);

  if (!singleton.messages.has(jid)) {
    singleton.messages.set(jid, []);
  }

  const bucket = singleton.messages.get(jid);
  if (id && bucket.some(item => item.id === id)) {
    return;
  }

  bucket.push({
    id,
    sender,
    text,
    timestamp
  });

  bucket.sort((a, b) => a.timestamp - b.timestamp);
  if (bucket.length > singleton.maxStoredMessages) {
    bucket.splice(0, bucket.length - singleton.maxStoredMessages);
  }
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];

  for (const candidate of candidates) {
    const jid = String(candidate.jid || "").trim();
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    out.push({
      jid,
      label: candidate.label || jid,
      score: Number(candidate.score || 0),
      source: candidate.source || "unknown"
    });
  }

  return out;
}

function formatCandidateOptions(candidates) {
  return candidates
    .slice(0, 5)
    .map((item, idx) => `${idx + 1}. ${item.label}`)
    .join("; ");
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

  const directJid = candidates.find(c => c.jid.toLowerCase() === raw.toLowerCase());
  if (directJid) return directJid;

  const normalized = normalizeText(raw);
  if (!normalized) return null;

  const byLabel = candidates.find(c => normalizeText(c.label) === normalized);
  if (byLabel) return byLabel;

  return null;
}

function parseSendIntentFromInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  const patterns = [
    /send\s+(?:a\s+)?(?:whatsapp\s+)?message\s+(?:to|in|on)\s+(.+?)\s+saying\s+([\s\S]+)$/i,
    /(?:whatsapp\s+)?to\s+(.+?)\s+saying\s+([\s\S]+)$/i,
    /message\s+(?:to|in|on)\s+(.+?)\s+saying\s+([\s\S]+)$/i
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;

    let recipient = String(match[1] || "").trim();
    let message = String(match[2] || "").trim();

    recipient = recipient
      .replace(/\bgroup\b$/i, "")
      .replace(/^the\s+/i, "")
      .replace(/[.!?]+$/g, "")
      .trim();

    message = message
      .replace(/^that\s+/i, "")
      .trim();

    if (recipient && message) {
      return { recipient, message };
    }
  }

  return null;
}

function scoreTextMatch(query, label) {
  const q = normalizeText(query);
  const l = normalizeText(label);
  if (!q || !l) return 0;
  if (q === l) return 6;
  if (l.includes(q)) return 4;

  const qTokens = q.split(" ").filter(Boolean);
  const lTokens = new Set(l.split(" ").filter(Boolean));
  if (qTokens.length === 0) return 0;

  let hits = 0;
  for (const token of qTokens) {
    if (lTokens.has(token)) hits++;
  }

  const ratio = hits / qTokens.length;
  if (ratio >= 0.5) return 2 + ratio * 2;
  return 0;
}

async function maybeLoadGooglePeople(credentialsPath, tokenPath) {
  try {
    if (!credentialsPath || !tokenPath) return null;
    if (!fs.existsSync(credentialsPath) || !fs.existsSync(tokenPath)) return null;

    const { google } = require("googleapis");
    const credentials = JSON.parse(fs.readFileSync(credentialsPath));
    const token = JSON.parse(fs.readFileSync(tokenPath));

    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oauth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    oauth.setCredentials(token);

    return google.people({ version: "v1", auth: oauth });
  } catch (_) {
    return null;
  }
}

async function ensureSocket(authPath) {
  if (singleton.socket && singleton.connectionState === "open") {
    return { ok: true };
  }

  if (singleton.connecting) {
    return await singleton.connecting;
  }

  singleton.connecting = (async () => {
    try {
      if (!makeWASocket || !useMultiFileAuthState || !fetchLatestBaileysVersion) {
        throw new Error("Baileys APIs are unavailable. Check installed version.");
      }

      const resolvedAuth = path.resolve(authPath || path.join(process.cwd(), "plugins", "whatsapp", "auth"));
      fs.mkdirSync(resolvedAuth, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(resolvedAuth);
      const { version } = await fetchLatestBaileysVersion();

      const socket = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        markOnlineOnConnect: false,
        syncFullHistory: true,
        browser: ["BTW Interpreter", "Chrome", "1.0.0"]
      });

      socket.ev.on("creds.update", saveCreds);

      socket.ev.on("connection.update", update => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && qr !== singleton.lastQr) {
          singleton.lastQr = qr;
          console.log("\n[WhatsApp] Scan this QR code with WhatsApp Linked Devices:\n");
          qrcode.generate(qr, { small: true });
          console.log("\n[WhatsApp] Waiting for device to connect...\n");
        }

        if (connection) {
          singleton.connectionState = connection;
          if (connection === "open") {
            console.log("[WhatsApp] Connected.");
          }
        }

        if (connection === "close") {
          const statusCode = Number(lastDisconnect?.error?.output?.statusCode || 0);
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          singleton.lastError = String(lastDisconnect?.error?.message || "Connection closed");
          if (loggedOut) {
            singleton.socket = null;
            singleton.connectionState = "closed";
          }
        }
      });

      socket.ev.on("chats.upsert", chats => {
        for (const chat of chats || []) {
          if (!chat?.id) continue;
          singleton.chats.set(chat.id, {
            id: chat.id,
            name: chat.name || chat.subject || chat.pushName || chat.id,
            isGroup: chat.id.endsWith("@g.us")
          });
        }
      });

      socket.ev.on("messaging-history.set", payload => {
        const chats = payload?.chats || [];
        const messages = payload?.messages || [];

        for (const chat of chats) {
          if (!chat?.id) continue;
          singleton.chats.set(chat.id, {
            id: chat.id,
            name: chat.name || chat.subject || chat.pushName || chat.id,
            isGroup: chat.id.endsWith("@g.us")
          });
        }

        for (const msg of messages) {
          const jid = msg?.key?.remoteJid;
          if (!jid || !jid.endsWith("@g.us")) continue;
          ingestMessageToHistory(msg);
        }

        if (payload?.isLatest) {
          singleton.historyBootstrapDone = true;
        }
      });

      socket.ev.on("contacts.upsert", contacts => {
        for (const contact of contacts || []) {
          if (!contact?.id) continue;
          const label = contact.notify || contact.name || contact.verifiedName || contact.id;
          singleton.chats.set(contact.id, {
            id: contact.id,
            name: label,
            isGroup: contact.id.endsWith("@g.us")
          });
        }
      });

      socket.ev.on("messages.upsert", event => {
        const messages = event?.messages || [];
        for (const msg of messages) {
          ingestMessageToHistory(msg);
        }
      });

      singleton.socket = socket;
      singleton.authPath = resolvedAuth;

      return { ok: true };
    } catch (err) {
      singleton.lastError = String(err?.message || err);
      return { ok: false, message: singleton.lastError };
    } finally {
      singleton.connecting = null;
    }
  })();

  return await singleton.connecting;
}

async function waitForConnectionOpen(timeoutMs = 12000, intervalMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (singleton.connectionState === "open") return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return singleton.connectionState === "open";
}

class WhatsAppPlugin {
  constructor(auth_path, default_country_code, contacts_credentials_path, contacts_token_path, obj) {
    this.authPath = auth_path;
    this.defaultCountryCode = default_country_code || "";
    this.contactsCredentialsPath = contacts_credentials_path;
    this.contactsTokenPath = contacts_token_path;
    this.obj = obj;
  }

  async prefillWorkflowParams({ workflow, input, params }) {
    if (workflow !== "send_whatsapp_message") {
      return {};
    }

    const parsed = parseSendIntentFromInput(input || "");
    if (!parsed) {
      return {};
    }

    const next = {};
    if ((!params?.recipient || !String(params.recipient).trim()) && parsed.recipient) {
      next.recipient = parsed.recipient;
    }
    if ((!params?.message || !String(params.message).trim()) && parsed.message) {
      next.message = parsed.message;
    }
    return next;
  }

  async ensureReady() {
    const initialized = await ensureSocket(this.authPath);
    if (!initialized.ok) {
      return {
        ok: false,
        message: `WhatsApp initialization failed: ${initialized.message}`
      };
    }

    if (singleton.connectionState !== "open") {
      const opened = await waitForConnectionOpen(12000, 500);
      if (opened) {
        return { ok: true };
      }

      return {
        ok: false,
        message: "WhatsApp is not connected yet. Scan QR shown in terminal and retry in a few seconds."
      };
    }

    return { ok: true };
  }

  async resolveRecipient(recipientInput, groupName = "") {
    const direct = String(recipientInput || "").trim();
    if (!direct) {
      return {
        ok: false,
        message: "Please provide recipient name or phone number."
      };
    }

    const candidates = [];

    if (isPhoneLike(direct)) {
      const jid = phoneToJid(direct, this.defaultCountryCode);
      if (jid) {
        return {
          ok: true,
          jid,
          label: direct,
          source: "phone"
        };
      }
    }

    const query = normalizeText(groupName || direct);
    for (const chat of singleton.chats.values()) {
      if (!chat?.id) continue;
      if (groupName && !chat.isGroup) continue;
      if (!groupName && chat.isGroup) {
        // keep groups for explicit group sends only
        continue;
      }

      const score = scoreTextMatch(query, chat.name || chat.id);
      if (score <= 0) continue;

      candidates.push({
        jid: chat.id,
        label: `${chat.name || "Unknown"} <${chat.id}>`,
        score,
        source: "whatsapp"
      });
    }

    if (candidates.length === 0) {
      const people = await maybeLoadGooglePeople(this.contactsCredentialsPath, this.contactsTokenPath);
      if (people) {
        try {
          const searched = await people.people.searchContacts({
            query: direct,
            readMask: "names,phoneNumbers",
            pageSize: 20
          });

          for (const item of searched.data.results || []) {
            const person = item.person || {};
            const name = person.names?.[0]?.displayName || "Unknown";
            const phones = person.phoneNumbers || [];

            for (const ph of phones) {
              const value = String(ph.value || "").trim();
              const jid = phoneToJid(value, this.defaultCountryCode);
              if (!jid) continue;

              const score = scoreTextMatch(direct, name);
              candidates.push({
                jid,
                label: `${name} <${value}>`,
                score: Math.max(2, score),
                source: "google_contacts"
              });
            }
          }
        } catch (_) {
          // best effort; ignore and continue with available candidates
        }
      }
    }

    const unique = dedupeCandidates(candidates).sort((a, b) => b.score - a.score);
    if (unique.length === 0) {
      return {
        ok: false,
        message: `No WhatsApp recipient match found for \"${direct}\". Provide full phone number with country code.`
      };
    }

    if (unique.length === 1) {
      return {
        ok: true,
        jid: unique[0].jid,
        label: unique[0].label,
        source: unique[0].source
      };
    }

    return {
      ok: false,
      candidates: unique.slice(0, 5),
      message: `Multiple or fuzzy WhatsApp matches for \"${direct}\". Choose one by number or provide exact phone number. Options: ${formatCandidateOptions(unique)}`
    };
  }

  async sendMessageWorkflow(params, context = {}) {
    const ready = await this.ensureReady();
    if (!ready.ok) {
      return {
        status: "needs_input",
        field: "recipient",
        message: ready.message
      };
    }

    await this.hydrateGroups();

    const parsed = parseSendIntentFromInput(context.input || "");
    if ((!params.recipient || !String(params.recipient).trim()) && parsed?.recipient) {
      params.recipient = parsed.recipient;
    }
    if ((!params.message || !String(params.message).trim()) && parsed?.message) {
      params.message = parsed.message;
    }

    const recipient = String(params.recipient || "").trim();
    const text = String(params.message || "").trim();
    const group = String(params.group || "").trim();

    if (!recipient || !text) {
      return {
        status: "needs_input",
        field: !recipient ? "recipient" : "message",
        message: !recipient ? "Please provide recipient name or phone number." : "Please provide message text."
      };
    }

    const candidatePool = Array.isArray(params._recipientCandidates) ? params._recipientCandidates : [];

    let resolved;
    if (candidatePool.length > 0) {
      let selected =
        selectCandidateFromInput(String(context.input || "").trim(), candidatePool) ||
        selectCandidateFromInput(recipient, candidatePool);

      if (!selected && candidatePool.length === 1) {
        selected = candidatePool[0];
      }

      if (!selected) {
        return {
          status: "needs_input",
          field: "recipient",
          message: `Please choose recipient by option number or exact phone. Options: ${formatCandidateOptions(candidatePool)}`
        };
      }

      resolved = {
        ok: true,
        jid: selected.jid,
        label: selected.label,
        source: selected.source
      };
    } else {
      resolved = await this.resolveRecipient(recipient, group);

      // If direct-chat lookup misses and no explicit group field is present,
      // retry by treating recipient text as a group name.
      if (!resolved.ok && !group) {
        const asGroup = await this.resolveRecipient(recipient, recipient);
        if (asGroup.ok || (Array.isArray(asGroup.candidates) && asGroup.candidates.length > 0)) {
          resolved = asGroup;
        }
      }
    }

    if (!resolved.ok) {
      if (Array.isArray(resolved.candidates) && resolved.candidates.length > 0) {
        params._recipientCandidates = resolved.candidates;
      }

      return {
        status: "needs_input",
        field: "recipient",
        message: resolved.message
      };
    }

    delete params._recipientCandidates;
    await singleton.socket.sendMessage(resolved.jid, { text });
    return `WhatsApp message sent successfully to ${resolved.label}.`;
  }

  async hydrateGroups() {
    if (!singleton.socket || typeof singleton.socket.groupFetchAllParticipating !== "function") {
      return;
    }

    try {
      const groups = await singleton.socket.groupFetchAllParticipating();
      for (const [id, data] of Object.entries(groups || {})) {
        if (!id || !id.endsWith("@g.us")) continue;
        singleton.chats.set(id, {
          id,
          name: data?.subject || data?.name || id,
          isGroup: true
        });
      }
    } catch (_) {
      // best-effort hydration; keep existing cache if API is unavailable or fails.
    }
  }

  async summarizeGroupConversation(query) {
    const ready = await this.ensureReady();
    if (!ready.ok) return ready.message;

    await this.hydrateGroups();

    const parsePrompt =
`Extract WhatsApp group summary intent from user query.
Return only JSON with schema:
{
  "group_query": "string or null",
  "max_messages": number
}
Rules:
- max_messages default 40
- cap max_messages to 120
- if no explicit group, group_query can be null
Query: ${JSON.stringify(query)}
`;

    let parsed = { group_query: null, max_messages: 40 };
    try {
      const raw = await this.obj.customQuery(parsePrompt);
      const match = String(raw || "").match(/\{[\s\S]*\}/);
      if (match) {
        const json = JSON.parse(match[0]);
        parsed = {
          group_query: json.group_query || null,
          max_messages: Math.max(5, Math.min(120, Number(json.max_messages) || 40))
        };
      }
    } catch (_) {
      parsed = { group_query: null, max_messages: 40 };
    }

    const groups = [];
    for (const chat of singleton.chats.values()) {
      if (!chat?.isGroup) continue;
      const score = parsed.group_query ? scoreTextMatch(parsed.group_query, chat.name || chat.id) : 1;
      if (score <= 0) continue;
      groups.push({ id: chat.id, name: chat.name || chat.id, score });
    }

    groups.sort((a, b) => b.score - a.score);
    if (groups.length === 0) {
      return "I could not find a matching WhatsApp group in the current session. Open WhatsApp and sync chats first.";
    }

    if (groups.length > 1 && parsed.group_query) {
      const sameScore = groups.filter(g => g.score === groups[0].score);
      if (sameScore.length > 1) {
        const options = sameScore.slice(0, 5).map((g, i) => `${i + 1}. ${g.name}`).join("; ");
        return `Multiple groups matched. Please specify the group name more clearly. Options: ${options}`;
      }
    }

    const selected = groups[0];
    const bucket = singleton.messages.get(selected.id) || [];
    const messages = bucket
      .filter(item => item.text && item.text.trim())
      .slice(-parsed.max_messages)
      .map(item => {
        const when = new Date(item.timestamp * 1000).toISOString().slice(0, 16).replace("T", " ");
        return `[${when}] ${item.sender}: ${item.text}`;
      });

    if (messages.length === 0) {
      return `I do not have recent text messages cached for ${selected.name} yet. After initial sync, I keep up to the latest 50 messages per group.`;
    }

    const summarizePrompt =
`You summarize WhatsApp group conversations.
Output plain text only, concise, and accurate.
User query: ${JSON.stringify(query)}
Group: ${selected.name}
Messages:\n${messages.join("\n")}
`;

    try {
      return await this.obj.customQuery(summarizePrompt);
    } catch (err) {
      return `Failed to summarize group conversation: ${String(err?.message || err)}`;
    }
  }
}

module.exports = WhatsAppPlugin;
