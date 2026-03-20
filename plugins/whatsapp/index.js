const fs = require("fs");
const path = require("path");
const baileys = require("baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const { extractContent, extractLinksFromText, formatExtractedContent } = require("../../src/contentExtractor");

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
const Browsers = baileys.Browsers || null;

let singleton = {
  socket: null,
  connecting: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  connectionState: "closed",
  lastError: "",
  lastQr: "",
  authPath: "",
  cachePath: "",
  cacheLoaded: false,
  saveTimer: null,
  globalLastDigestAt: 0,
  chatCheckpoints: new Map(),
  pendingSelection: null,
  lastSummaryContext: null,
  chats: new Map(),
  messages: new Map(),
  linkSummaries: new Map(), // jid -> array of { url, summary, platform, timestamp }
  maxStoredMessages: 50,
  historyBootstrapDone: false
};

function getBrowserIdentity() {
  if (Browsers && typeof Browsers.macOS === "function") {
    return Browsers.macOS("Desktop");
  }
  return ["BTW Interpreter", "Chrome", "1.0.0"];
}

function mapDisconnectError(statusCode, rawMessage) {
  const msg = String(rawMessage || "").toLowerCase();
  if (statusCode === 440 || msg.includes("conflict")) {
    return "WhatsApp session conflict (code 440): another client is using the same auth session.";
  }
  if (statusCode === Number(DisconnectReason.loggedOut)) {
    return "WhatsApp session logged out. Delete plugins/whatsapp/auth and relink by scanning QR.";
  }
  if (statusCode === Number(DisconnectReason.restartRequired)) {
    return "WhatsApp requested restart. Reconnecting automatically.";
  }
  if (msg.includes("couldn't log in") || msg.includes("could not log in") || msg.includes("phone's internet")) {
    return "Phone refused login handshake. Keep phone unlocked with stable internet, then rescan QR. If it repeats, delete plugins/whatsapp/auth and relink.";
  }
  if (statusCode > 0) {
    return `WhatsApp disconnected (code ${statusCode}). ${String(rawMessage || "").trim()}`;
  }
  return String(rawMessage || "Connection closed");
}

function clearReconnectTimer() {
  if (!singleton.reconnectTimer) return;
  clearTimeout(singleton.reconnectTimer);
  singleton.reconnectTimer = null;
}

function scheduleReconnect(authPath) {
  clearReconnectTimer();
  const attempt = Math.min(6, singleton.reconnectAttempts + 1);
  singleton.reconnectAttempts = attempt;
  const delayMs = Math.min(30000, 1500 * Math.pow(2, attempt - 1));

  singleton.reconnectTimer = setTimeout(() => {
    singleton.reconnectTimer = null;
    ensureSocket(authPath).catch(() => {});
  }, delayMs);
}

function getCachePathFromAuthPath(authPath) {
  const resolvedAuth = path.resolve(authPath || path.join(process.cwd(), "plugins", "whatsapp", "auth"));
  return path.join(path.dirname(resolvedAuth), "message_cache.json");
}

function parseEpoch(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function persistCacheNow() {
  if (!singleton.cachePath) return;
  try {
    fs.mkdirSync(path.dirname(singleton.cachePath), { recursive: true });
    const payload = {
      updatedAt: new Date().toISOString(),
      chats: Array.from(singleton.chats.entries()),
      messages: Array.from(singleton.messages.entries()).map(([jid, items]) => [
        jid,
        Array.isArray(items) ? items.slice(-singleton.maxStoredMessages) : []
      ]),
      linkSummaries: Array.from(singleton.linkSummaries.entries()).map(([jid, items]) => [
        jid,
        Array.isArray(items) ? items.slice(-20) : [] // Keep last 20 links per chat
      ]),
      checkpoints: {
        globalLastDigestAt: singleton.globalLastDigestAt,
        perChat: Object.fromEntries(singleton.chatCheckpoints.entries())
      }
    };
    fs.writeFileSync(singleton.cachePath, JSON.stringify(payload, null, 2));
  } catch (_) {
    // best effort persistence
  }
}

function schedulePersistCache() {
  if (!singleton.cachePath || singleton.saveTimer) return;
  singleton.saveTimer = setTimeout(() => {
    singleton.saveTimer = null;
    persistCacheNow();
  }, 750);
}

function loadPersistedCache(authPath) {
  const cachePath = getCachePathFromAuthPath(authPath);
  if (singleton.cacheLoaded && singleton.cachePath === cachePath) return;

  singleton.cachePath = cachePath;
  singleton.cacheLoaded = true;

  try {
    if (!fs.existsSync(cachePath)) return;
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));

    const chatEntries = Array.isArray(parsed?.chats) ? parsed.chats : [];
    const messageEntries = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const linkEntries = Array.isArray(parsed?.linkSummaries) ? parsed.linkSummaries : [];
    const cp = parsed?.checkpoints || {};

    singleton.chats = new Map(chatEntries.filter(e => Array.isArray(e) && e.length === 2));
    singleton.messages = new Map(
      messageEntries
        .filter(e => Array.isArray(e) && e.length === 2)
        .map(([jid, items]) => [jid, Array.isArray(items) ? items.slice(-singleton.maxStoredMessages) : []])
    );
    singleton.linkSummaries = new Map(
      linkEntries
        .filter(e => Array.isArray(e) && e.length === 2)
        .map(([jid, items]) => [jid, Array.isArray(items) ? items : []])
    );

    singleton.globalLastDigestAt = parseEpoch(cp.globalLastDigestAt, 0);
    singleton.chatCheckpoints = new Map(
      Object.entries(cp.perChat || {}).map(([jid, ts]) => [jid, parseEpoch(ts, 0)])
    );

    // Auto-populate chats from message JIDs that don't have explicit chat entries
    // This ensures community chats and DMs without explicit metadata are still findable
    for (const jid of singleton.messages.keys()) {
      if (!singleton.chats.has(jid)) {
        const isGroup = jid.endsWith("@g.us");
        const isDm = jid.endsWith("@s.whatsapp.net");
        const isCommunity = jid.endsWith("@lid");
        singleton.chats.set(jid, {
          id: jid,
          name: jid, // Fallback to JID as name
          isGroup,
          isDm,
          isCommunity
        });
      }
    }

    if (singleton.messages.size > 0) {
      singleton.historyBootstrapDone = true;
      console.log(`[WhatsApp] Loaded cache: ${singleton.chats.size} chats, ${singleton.messages.size} chats with messages, ${singleton.linkSummaries.size} chats with links.`);
    }
  } catch (_) {
    // ignore malformed cache
  }
}

function mergeSocketStoreMessages(targetJid = "") {
  if (!singleton.socket?.messages || !(singleton.socket.messages instanceof Map)) {
    return 0;
  }

  let loaded = 0;
  for (const [chatId, list] of singleton.socket.messages.entries()) {
    if (!chatId) continue;
    if (targetJid && chatId !== targetJid) continue;
    for (const proto of list || []) {
      const msg = proto?.message
        ? {
            key: proto.key,
            message: proto.message,
            messageTimestamp: proto.messageTimestamp,
            pushName: proto.pushName
          }
        : proto;
      ingestMessageToHistory(msg);
      loaded++;
    }
  }

  if (loaded > 0) {
    schedulePersistCache();
  }
  return loaded;
}

async function pullChatHistoryFromSocket(jid, limit = 80) {
  if (!jid || !singleton.socket) return 0;

  let loaded = mergeSocketStoreMessages(jid);
  const socket = singleton.socket;

  // Try known Baileys history APIs if socket store has no items for this chat.
  const collect = payload => {
    const items = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.messages)
        ? payload.messages
        : [];

    for (const proto of items) {
      const msg = proto?.message
        ? {
            key: proto.key,
            message: proto.message,
            messageTimestamp: proto.messageTimestamp,
            pushName: proto.pushName
          }
        : proto;
      ingestMessageToHistory(msg);
      loaded++;
    }
  };

  if (typeof socket.loadMessages === "function") {
    try {
      const res = await socket.loadMessages(jid, limit);
      collect(res);
    } catch (_) {
      // ignore and try next API
    }
  }

  if (typeof socket.fetchMessageHistory === "function") {
    try {
      const res = await socket.fetchMessageHistory(jid, limit);
      collect(res);
    } catch (_) {
      // ignore and try alt signatures
      try {
        const res = await socket.fetchMessageHistory(jid, limit, undefined, undefined);
        collect(res);
      } catch (_) {
        // no-op
      }
    }
  }

  if (loaded > 0) {
    schedulePersistCache();
  }
  return loaded;
}

function getHistoryDiagnostics() {
  const socket = singleton.socket;
  const hasSocket = Boolean(socket);
  const hasStore = Boolean(socket?.messages && socket.messages instanceof Map);
  const storeChatsWithMessages = hasStore ? socket.messages.size : 0;

  return {
    hasSocket,
    hasLoadMessages: typeof socket?.loadMessages === "function",
    hasFetchMessageHistory: typeof socket?.fetchMessageHistory === "function",
    hasSocketStore: hasStore,
    storeChatsWithMessages
  };
}

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
  if (message.viewOnceMessage?.message) return extractMessageText(message.viewOnceMessage.message);
  if (message.ephemeralMessage?.message) return extractMessageText(message.ephemeralMessage.message);
  if (message.stickerMessage) return "[sticker]";
  if (message.audioMessage) return "[audio]";
  return "";
}

/**
 * Process links in a message and extract their content
 * This runs asynchronously in background; extracted summaries are cached
 */
async function processLinksInMessage(jid, messageText, sender, timestamp) {
  if (!jid || !messageText) return;

  const links = extractLinksFromText(messageText);
  if (links.length === 0) return;

  if (!singleton.linkSummaries.has(jid)) {
    singleton.linkSummaries.set(jid, []);
  }

  const bucket = singleton.linkSummaries.get(jid);

  // Process each link (non-blocking, with timeout per link)
  for (const url of links) {
    try {
      // Check if we already have this link
      if (bucket.some(item => item.url === url)) {
        continue;
      }

      // Extract content from the link
      const extracted = await Promise.race([
        extractContent(url),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 10000)
        )
      ]);

      if (!extracted) continue;

      // Format the extracted content into a summary-friendly text
      const contentText = formatExtractedContent(extracted);

      bucket.push({
        url,
        platform: extracted.platform || "generic",
        title: extracted.title || "",
        summary: contentText.substring(0, 2000), // Limit to 2000 chars
        sender,
        timestamp,
        extractedAt: Math.floor(Date.now() / 1000)
      });
    } catch (err) {
      // Log but don't fail - link extraction is background task
      console.warn(`[WhatsApp] Failed to extract link ${url}: ${err.message}`);
    }
  }

  // Trim bucket to last 20 links
  if (bucket.length > 20) {
    bucket.splice(0, bucket.length - 20);
  }

  schedulePersistCache();
}

/**
 * Helper: Format link summaries for inclusion in LLM prompts
 */
function formatLinksForPrompt(jid, sinceTs = 0) {
  const bucket = singleton.linkSummaries.get(jid) || [];
  const recentLinks = bucket.filter(link => Number(link.timestamp || 0) > sinceTs);

  if (recentLinks.length === 0) return "";

  const formatted = recentLinks
    .map(link => {
      const when = new Date(Number(link.timestamp || 0) * 1000).toISOString().slice(0, 16).replace("T", " ");
      return `[${when}] ${link.platform.toUpperCase()} from ${link.sender}:\n  URL: ${link.url}\n  ${link.title || ""}\n  ${link.summary.substring(0, 300)}...`;
    })
    .join("\n\n");

  return `\n\n[SHARED LINKS & CONTENT]\n${formatted}`;
}

function getRecentLinkSources(jid, limit = 8) {
  const bucket = singleton.linkSummaries.get(jid) || [];
  return bucket
    .slice(-Math.max(1, Number(limit) || 8))
    .map(item => ({
      url: item.url,
      platform: item.platform || "generic",
      title: item.title || "",
      summary: String(item.summary || "").slice(0, 800),
      sender: item.sender || "unknown",
      timestamp: Number(item.timestamp || 0)
    }));
}

function formatSourcesAppendix(sources = []) {
  if (!Array.isArray(sources) || sources.length === 0) return "";
  const lines = sources
    .slice(0, 5)
    .map((s, idx) => `${idx + 1}. [${String(s.platform || "generic").toUpperCase()}] ${s.title || s.url} -> ${s.url}`);
  return `\n\nSources:\n${lines.join("\n")}`;
}

function rememberSummaryContext(payload = {}) {
  singleton.lastSummaryContext = {
    createdAt: Date.now(),
    lastFollowUpAt: Date.now(),
    chatName: payload.chatName || "",
    chatId: payload.chatId || "",
    userQuery: payload.userQuery || "",
    messageLines: Array.isArray(payload.messageLines) ? payload.messageLines.slice(-120) : [],
    links: Array.isArray(payload.links) ? payload.links.slice(-12) : [],
    followUpHistory: []
  };
}

function appendFollowUpHistory(question, response) {
  const ctx = singleton.lastSummaryContext;
  if (!ctx) return;
  if (!Array.isArray(ctx.followUpHistory)) {
    ctx.followUpHistory = [];
  }
  ctx.followUpHistory.push({
    at: Date.now(),
    question: String(question || "").slice(0, 400),
    response: String(response || "").slice(0, 1200)
  });
  if (ctx.followUpHistory.length > 6) {
    ctx.followUpHistory = ctx.followUpHistory.slice(-6);
  }
  ctx.lastFollowUpAt = Date.now();
}

function isLikelyContinuationReply(input) {
  const text = normalizeText(input);
  if (!text) return false;
  if (text.split(" ").length > 12) return false;
  return /^(yes|yeah|yup|no|nope|idk|i dont know|not sure|maybe|more|mainly|mostly|for|use|purpose|budget|coding|ai|ml|deep learning|workflows|linux|battery|performance|portability|build quality)/i.test(text);
}

function inferFocusEntity(ctx, input) {
  const current = normalizeText(input);
  const historyText = (ctx?.followUpHistory || [])
    .slice(-2)
    .map(h => `${h?.question || ""} ${h?.response || ""}`)
    .join(" ");
  const merged = `${current} ${normalizeText(historyText)}`;

  if (/\basus|zenbook\b/i.test(merged)) return "asus";
  if (/\blenovo|yoga\b/i.test(merged)) return "lenovo";
  if (/\bmacbook|neo|apple\b/i.test(merged)) return "macbook_neo";
  if (/\bgithub|repo|repository|memoria\b/i.test(merged)) return "github_repo";
  return "";
}

function isLikelyContextFollowUp(input) {
  const text = normalizeText(input);
  if (!text) return false;
  return /(what|which|where|when|who|details|detail|about|repo|repository|github|link|source|youtube|instagram|twitter|facebook|reel|video|post|that one|first|second|third|thought|thoughts|opinion|recommend|worth|buy|good|better|laptop|phone|pc)/i.test(text);
}

function isExplicitWebLookupRequest(input) {
  const text = normalizeText(input);
  if (!text) return false;
  return /(lookup|look up|search|find|web|online|internet|google|reviews|latest reviews|news|check reviews)/i.test(text);
}

async function answerFromRecentSummaryContext(obj, input) {
  const ctx = singleton.lastSummaryContext;
  if (!ctx) return { handled: false };

  if (isExplicitWebLookupRequest(input)) {
    return { handled: false };
  }

  if (Date.now() - Number(ctx.createdAt || 0) > 30 * 60 * 1000) {
    singleton.lastSummaryContext = null;
    return { handled: false };
  }

  const contextFollowUp = isLikelyContextFollowUp(input);
  const continuationReply = isLikelyContinuationReply(input) && (Date.now() - Number(ctx.lastFollowUpAt || ctx.createdAt || 0) <= 8 * 60 * 1000);
  if (!contextFollowUp && !continuationReply) {
    return { handled: false };
  }

  const followUpText = String(input || "");
  const isOpinionQuestion = /(thought|thoughts|opinion|recommend|worth|buy|good|better|should i|which one)/i.test(followUpText);
  const focusEntity = inferFocusEntity(ctx, input);

  const prompt =
`You are answering a WhatsApp follow-up question using provided context from a recent WhatsApp summary.
Use only these messages/sources as evidence.
If the question asks for opinion/recommendation, provide a practical opinion grounded in available specs/details and clearly mention uncertainty where data is missing.
If there are multiple matching items (e.g., two laptops) and the user says "that laptop", briefly compare the likely options and ask one short clarifying question at the end.
Maintain flow with prior turns: treat short continuation replies like "more for ai workflows" as follow-up context, not as a new topic.
Avoid generic advice disconnected from the provided laptops/videos/links.
If primary focus is known, keep the answer centered on that item and only mention alternatives briefly.
Do not say "I have no context" unless context is truly empty.
Output concise plain text.

Question type: ${isOpinionQuestion ? "opinion_or_recommendation" : "fact_lookup"}
Primary focus: ${focusEntity || "none"}

Follow-up question: ${JSON.stringify(String(input || ""))}
Previous summary context:
- Chat: ${ctx.chatName || ctx.chatId || "unknown"}
- Original query: ${JSON.stringify(ctx.userQuery || "")}

Messages:
${(ctx.messageLines || []).join("\n")}

Content sources:
${(ctx.links || []).map((s, i) => `${i + 1}. platform=${s.platform} title=${s.title} sender=${s.sender} url=${s.url}\nsummary=${s.summary}`).join("\n")}

Recent follow-up turns:
${(ctx.followUpHistory || []).map((h, i) => `${i + 1}. Q=${h.question}\nA=${h.response}`).join("\n")}
`;

  try {
    const response = await obj.customQuery(prompt);
    appendFollowUpHistory(input, response);
    return { handled: true, response };
  } catch (_) {
    return { handled: false };
  }
}

async function ensureLinkSummariesForChat(jid, maxMessages = 40) {
  if (!jid) return;
  const bucket = singleton.messages.get(jid) || [];
  if (bucket.length === 0) return;

  const start = Math.max(0, bucket.length - Math.max(5, Math.min(120, Number(maxMessages) || 40)));
  const slice = bucket.slice(start);
  for (const item of slice) {
    if (!item?.text) continue;
    if (!extractLinksFromText(item.text).length) continue;
    await processLinksInMessage(jid, item.text, item.sender || "unknown", Number(item.timestamp || Math.floor(Date.now() / 1000)));
  }
}

function ingestMessageToHistory(msg) {
  const jid = msg?.key?.remoteJid;
  if (!jid) return;

  const text = extractMessageText(msg.message || msg);
  if (!text || !String(text).trim()) return;

  const id = String(msg?.key?.id || "").trim();
  const sender = msg.pushName || msg.key?.participant || msg.key?.remoteJid || "unknown";
  const timestampRaw = msg.messageTimestamp || msg.timestamp;
  const timestamp = timestampRaw ? Number(timestampRaw) : Math.floor(Date.now() / 1000);
  const fromMe = Boolean(msg?.key?.fromMe);

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
    timestamp,
    fromMe
  });

  bucket.sort((a, b) => a.timestamp - b.timestamp);
  if (bucket.length > singleton.maxStoredMessages) {
    bucket.splice(0, bucket.length - singleton.maxStoredMessages);
  }

  // Extract and summarize links in the message (async, background operation)
  processLinksInMessage(jid, text, sender, timestamp).catch(() => {
    // Silently fail - link extraction is best-effort
  });

  schedulePersistCache();
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

  const directJid = candidates.find(c => c.jid.toLowerCase() === raw.toLowerCase());
  if (directJid) return directJid;

  const normalized = normalizeText(raw);
  if (!normalized) return null;

  const byLabel = candidates.find(c => normalizeText(c.label) === normalized);
  if (byLabel) return byLabel;

  return null;
}

function selectIndexFromInput(input, maxLen) {
  const raw = String(input || "").trim();
  if (!raw) return -1;

  const numeric = raw.match(/^(?:option\s*)?(\d{1,2})$/i);
  if (numeric) {
    const idx = Number(numeric[1]) - 1;
    if (idx >= 0 && idx < maxLen) return idx;
  }

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

  const normalized = normalizeText(raw).replace(/^option\s+/, "").trim();
  if (Object.prototype.hasOwnProperty.call(ordinalMap, normalized)) {
    const idx = ordinalMap[normalized] - 1;
    if (idx >= 0 && idx < maxLen) return idx;
  }

  return -1;
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

function extractExplicitChatQuery(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  const match = raw.match(/\b(?:in|from|of|for|to)\s+([^?.!,\n]+)/i);
  if (!match) return "";

  let value = String(match[1] || "").trim();
  value = value.replace(/^the\s+/i, "").trim();
  value = value
    .replace(/\b(?:for\s+me|to\s+me)\b.*$/i, "")
    .replace(/\b(?:please|pls|plz|right\s+now|today|now)\b.*$/i, "")
    .trim();
  value = value.replace(/\b(?:group|chat)\b\s*$/i, "").trim();
  value = value.replace(/\s+/g, " ").trim();

  if (!value) return "";
  if (value.length > 80) return "";
  return value;
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
      loadPersistedCache(resolvedAuth);

      const { state, saveCreds } = await useMultiFileAuthState(resolvedAuth);
      const { version } = await fetchLatestBaileysVersion();

      const socket = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        markOnlineOnConnect: false,
        syncFullHistory: true,
        browser: getBrowserIdentity()
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
            singleton.reconnectAttempts = 0;
            clearReconnectTimer();
            const merged = mergeSocketStoreMessages();
            if (merged > 0) {
              console.log(`[WhatsApp] Hydrated ${merged} messages from socket store.`);
            }
          }
        }

        if (connection === "close") {
          const statusCode = Number(lastDisconnect?.error?.output?.statusCode || 0);
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          const conflict = statusCode === 440;
          singleton.lastError = mapDisconnectError(statusCode, lastDisconnect?.error?.message);

          // Always drop stale socket object on close; it cannot be reused.
          singleton.socket = null;
          singleton.connectionState = "closed";

          console.log(`[WhatsApp] Disconnected: ${singleton.lastError}`);

          // Do not reconnect on logged-out or conflict loops.
          if (loggedOut || conflict) {
            clearReconnectTimer();
          } else {
            scheduleReconnect(resolvedAuth);
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
        schedulePersistCache();
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
          ingestMessageToHistory(msg);
        }

        if (payload?.isLatest) {
          singleton.historyBootstrapDone = true;
          mergeSocketStoreMessages();
          schedulePersistCache();
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
        schedulePersistCache();
      });

      socket.ev.on("messages.upsert", event => {
        const messages = event?.messages || [];
        for (const msg of messages) {
          ingestMessageToHistory(msg);
        }
      });

      socket.ev.on("messages.set", event => {
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

function isTransientReconnectState() {
  const err = String(singleton.lastError || "").toLowerCase();
  return (
    singleton.connectionState === "connecting" ||
    singleton.connecting !== null ||
    singleton.reconnectTimer !== null ||
    err.includes("restart") ||
    err.includes("connection closed")
  );
}

function resolveCandidateChats(chatQuery = "", chatType = "any") {
  const query = normalizeText(chatQuery || "");
  const candidates = [];

  for (const chat of singleton.chats.values()) {
    if (!chat?.id) continue;

    const isGroup = Boolean(chat.isGroup || String(chat.id).endsWith("@g.us"));
    const isDm = String(chat.id).endsWith("@s.whatsapp.net");
    const isCommunity = String(chat.id).endsWith("@lid");

    if (chatType === "group" && !isGroup) continue;
    if (chatType === "dm" && !isDm) continue;

    let score = 0;
    const label = chat.name || chat.id;
    
    // Score by chat name/label
    if (query) {
      score = scoreTextMatch(query, label);
    } else {
      score = 1;
    }

    // If name match is weak, try matching against sender names in this chat's messages
    if (score < 2 && query) {
      const messages = singleton.messages.get(chat.id) || [];
      const senderSet = new Set();
      for (const msg of messages) {
        if (msg.sender) senderSet.add(msg.sender);
      }
      for (const sender of senderSet) {
        const senderScore = scoreTextMatch(query, sender);
        if (senderScore > score) {
          score = senderScore;
        }
      }
    }

    if (score <= 0) continue;

    candidates.push({
      id: chat.id,
      name: label,
      isGroup,
      isDm,
      score
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function getCheckpointForChat(jid) {
  const ts = parseEpoch(singleton.chatCheckpoints.get(jid), 0);
  if (ts > 0) return ts;
  return parseEpoch(singleton.globalLastDigestAt, 0);
}

function updateCheckpointsForChats(chats, newestTs) {
  const ts = parseEpoch(newestTs, Math.floor(Date.now() / 1000));
  singleton.globalLastDigestAt = Math.max(parseEpoch(singleton.globalLastDigestAt, 0), ts);
  for (const chat of chats || []) {
    if (!chat?.id) continue;
    const prev = parseEpoch(singleton.chatCheckpoints.get(chat.id), 0);
    singleton.chatCheckpoints.set(chat.id, Math.max(prev, ts));
  }
  schedulePersistCache();
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

  async ensureReady(options = {}) {
    const allowCacheFallback = Boolean(options.allowCacheFallback);

    if (allowCacheFallback) {
      loadPersistedCache(this.authPath);
      if (singleton.messages.size > 0) {
        return { ok: true, cacheOnly: true };
      }
    }

    const initialized = await ensureSocket(this.authPath);
    if (!initialized.ok) {
      if (allowCacheFallback && singleton.messages.size > 0) {
        return { ok: true, cacheOnly: true };
      }
      return {
        ok: false,
        message: `WhatsApp initialization failed: ${initialized.message}`
      };
    }

    if (singleton.connectionState !== "open") {
      // Normal wait window for fresh QR scan / immediate connect.
      let opened = await waitForConnectionOpen(12000, 500);
      if (opened) {
        return { ok: true };
      }

      // If WhatsApp requested restart, keep waiting through automatic reconnect.
      if (isTransientReconnectState()) {
        ensureSocket(this.authPath).catch(() => {});
        opened = await waitForConnectionOpen(20000, 500);
        if (opened) {
          return { ok: true };
        }
      }

      if (allowCacheFallback && singleton.messages.size > 0) {
        return { ok: true, cacheOnly: true };
      }

      return {
        ok: false,
        message: singleton.lastError || "WhatsApp is not connected yet. Scan QR shown in terminal and retry in a few seconds."
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

  async warmMessageCache(limitPerChat = 40) {
    const ready = await this.ensureReady();
    if (!ready.ok) {
      return { ok: false, message: ready.message, loaded: 0 };
    }

    await this.hydrateGroups();
    let loaded = mergeSocketStoreMessages();

    const chats = Array.from(singleton.chats.values());
    for (const chat of chats) {
      if (!chat?.id) continue;
      const bucket = singleton.messages.get(chat.id) || [];
      if (bucket.length > 0) continue;
      loaded += await pullChatHistoryFromSocket(chat.id, limitPerChat);
    }

    schedulePersistCache();
    const diag = getHistoryDiagnostics();
    return {
      ok: true,
      loaded,
      chats: singleton.chats.size,
      chatsWithMessages: singleton.messages.size,
      diagnostics: diag
    };
  }

  async getNewMessagesDigest(query) {
    const ready = await this.ensureReady({ allowCacheFallback: true });
    if (!ready.ok) return ready.message;

    if (!ready.cacheOnly) {
      await this.hydrateGroups();
      mergeSocketStoreMessages();
    }

    const parsePrompt =
`Extract WhatsApp new-messages digest intent from user query.
Return JSON only:
{
  "chat_query": "string or null",
  "chat_type": "any|group|dm",
  "max_items": number
}
Rules:
Query: ${JSON.stringify(query)}
`;

    let parsed = { chat_query: null, chat_type: "any", max_items: 25 };
    try {
      const raw = await this.obj.customQuery(parsePrompt);
      const match = String(raw || "").match(/\{[\s\S]*\}/);
      if (match) {
        const json = JSON.parse(match[0]);
        parsed = {
          chat_query: json.chat_query || null,
          chat_type: ["any", "group", "dm"].includes(String(json.chat_type || "").toLowerCase())
            ? String(json.chat_type).toLowerCase()
            : "any",
          max_items: Math.max(5, Math.min(80, Number(json.max_items) || 25))
        };
      }
    } catch (_) {
      parsed = { chat_query: null, chat_type: "any", max_items: 25 };
    }

    const explicitChatQuery = extractExplicitChatQuery(query);
    if (explicitChatQuery) {
      parsed.chat_query = explicitChatQuery;
    }
    if (/\bgroup\b/i.test(String(query || ""))) {
      parsed.chat_type = "group";
    } else if (/\b(dm|dms|direct message|direct messages|personal chat)\b/i.test(String(query || ""))) {
      parsed.chat_type = "dm";
    }

    const chats = resolveCandidateChats(parsed.chat_query, parsed.chat_type);
    if (chats.length === 0) {
      return "I could not find a matching WhatsApp chat. Try a clearer chat/group name.";
    }

    const scopedChats = parsed.chat_query ? chats.slice(0, 3) : chats;
    const rows = [];
    let newestSeenTs = 0;
    let hadAnyCachedMessages = false;

    for (const chat of scopedChats) {
      const sinceTs = getCheckpointForChat(chat.id);
      let bucket = singleton.messages.get(chat.id) || [];
      await ensureLinkSummariesForChat(chat.id, parsed.max_items * 2);
      if (bucket.length === 0 && parsed.chat_query && !ready.cacheOnly) {
        await pullChatHistoryFromSocket(chat.id, Math.max(40, parsed.max_items * 2));
        bucket = singleton.messages.get(chat.id) || [];
      }
      if (bucket.length > 0) {
        hadAnyCachedMessages = true;
      }
      const fresh = bucket
        .filter(item => Number(item.timestamp || 0) > sinceTs && !item.fromMe)
        .slice(-parsed.max_items);

      for (const item of fresh) {
        const when = new Date(Number(item.timestamp || 0) * 1000).toISOString().slice(0, 16).replace("T", " ");
        rows.push(`[${when}] ${chat.name} | ${item.sender}: ${item.text}`);
        if (Number(item.timestamp || 0) > newestSeenTs) {
          newestSeenTs = Number(item.timestamp || 0);
        }
      }
    }

    if (rows.length === 0) {
      if (parsed.chat_query && !hadAnyCachedMessages) {
        return `I could resolve ${scopedChats[0].name}, but there are no cached text messages for this chat yet. Keep whatsapp_sync_daemon running while new messages arrive, then I can report unread and summarize.`;
      }
      return "No new WhatsApp messages since your last check.";
    }

    const maxLines = Math.min(rows.length, parsed.max_items);
    const digestPrompt =
`Summarize these NEW WhatsApp messages.
Focus on action items and important updates.
Keep it concise.
Messages:\n${rows.slice(-maxLines).join("\n")}${
  scopedChats.map(chat => formatLinksForPrompt(chat.id, getCheckpointForChat(chat.id))).join("")
}
`;

    let summary;
    try {
      summary = await this.obj.customQuery(digestPrompt);
    } catch (err) {
      summary = `I found ${rows.length} new messages but failed to summarize: ${String(err?.message || err)}`;
    }

    const digestSources = scopedChats.flatMap(chat => getRecentLinkSources(chat.id, 4)).slice(-8);
    rememberSummaryContext({
      chatName: scopedChats.length === 1 ? scopedChats[0].name : "multiple chats",
      chatId: scopedChats.length === 1 ? scopedChats[0].id : "",
      userQuery: query,
      messageLines: rows.slice(-Math.min(rows.length, 80)),
      links: digestSources
    });

    updateCheckpointsForChats(scopedChats, newestSeenTs || Math.floor(Date.now() / 1000));
    return `${summary}${formatSourcesAppendix(digestSources)}`;
  }

  async summarizeConversation(query) {
    const ready = await this.ensureReady({ allowCacheFallback: true });
    if (!ready.ok) return ready.message;

    if (!ready.cacheOnly) {
      await this.hydrateGroups();
      mergeSocketStoreMessages();
    }

    const parsePrompt =
`Extract WhatsApp chat summary intent from user query.
Return only JSON with schema:
{
  "chat_query": "string or null",
  "chat_type": "any|group|dm",
  "max_messages": number
}
Rules:
- max_messages default 40
- cap max_messages to 120
- if no explicit chat, chat_query can be null
Query: ${JSON.stringify(query)}
`;

    let parsed = { chat_query: null, chat_type: "any", max_messages: 40 };
    try {
      const raw = await this.obj.customQuery(parsePrompt);
      const match = String(raw || "").match(/\{[\s\S]*\}/);
      if (match) {
        const json = JSON.parse(match[0]);
        parsed = {
          chat_query: json.chat_query || null,
          chat_type: ["any", "group", "dm"].includes(String(json.chat_type || "").toLowerCase())
            ? String(json.chat_type).toLowerCase()
            : "any",
          max_messages: Math.max(5, Math.min(120, Number(json.max_messages) || 40))
        };
      }
    } catch (_) {
      parsed = { chat_query: null, chat_type: "any", max_messages: 40 };
    }

    const explicitChatQuery = extractExplicitChatQuery(query);
    if (explicitChatQuery) {
      parsed.chat_query = explicitChatQuery;
    }
    if (/\bgroup\b/i.test(String(query || ""))) {
      parsed.chat_type = "group";
    } else if (/\b(dm|dms|direct message|direct messages|personal chat)\b/i.test(String(query || ""))) {
      parsed.chat_type = "dm";
    }

    const chats = resolveCandidateChats(parsed.chat_query, parsed.chat_type);
    if (chats.length === 0) {
      return "I could not find a matching WhatsApp chat in the current session.";
    }

    if (chats.length > 1 && parsed.chat_query) {
      const sameScore = chats.filter(c => c.score === chats[0].score).slice(0, 5);
      if (sameScore.length > 1) {
        singleton.pendingSelection = {
          type: "summarize",
          query,
          options: sameScore,
          maxMessages: parsed.max_messages,
          createdAt: Date.now()
        };
        const options = sameScore.map((c, i) => `${i + 1}. ${c.name}`).join("; ");
        return `Multiple chats matched. Please specify the chat name more clearly. Options: ${options}`;
      }
    }

    const selected = chats[0];
    singleton.pendingSelection = null;
    let loaded = ready.cacheOnly ? 0 : mergeSocketStoreMessages(selected.id);
    await ensureLinkSummariesForChat(selected.id, parsed.max_messages);
    let bucket = singleton.messages.get(selected.id) || [];
    if (bucket.length === 0 && !ready.cacheOnly) {
      loaded += await pullChatHistoryFromSocket(selected.id, Math.max(60, parsed.max_messages));
      bucket = singleton.messages.get(selected.id) || [];
      await ensureLinkSummariesForChat(selected.id, parsed.max_messages);
    }

    const messages = bucket
      .filter(item => item.text && item.text.trim())
      .slice(-parsed.max_messages)
      .map(item => {
        const when = new Date(Number(item.timestamp || 0) * 1000).toISOString().slice(0, 16).replace("T", " ");
        return `[${when}] ${item.sender}: ${item.text}`;
      });

    if (messages.length === 0) {
      const diag = getHistoryDiagnostics();
      return `I do not have recent text messages cached for ${selected.name} yet. I attempted a live history pull (${loaded} items loaded). History APIs: loadMessages=${diag.hasLoadMessages}, fetchMessageHistory=${diag.hasFetchMessageHistory}, socketStoreChats=${diag.storeChatsWithMessages}.`;
    }

    const summarizePrompt =
`You summarize WhatsApp conversations.
Output plain text only, concise, and accurate.
User query: ${JSON.stringify(query)}
Chat: ${selected.name}
Messages:\n${messages.join("\n")}${formatLinksForPrompt(selected.id)}
`;

    try {
      const response = await this.obj.customQuery(summarizePrompt);
      const sources = getRecentLinkSources(selected.id, 8);
      rememberSummaryContext({
        chatName: selected.name,
        chatId: selected.id,
        userQuery: query,
        messageLines: messages,
        links: sources
      });
      return `${response}${formatSourcesAppendix(sources)}`;
    } catch (err) {
      return `Failed to summarize chat conversation: ${String(err?.message || err)}`;
    }
  }

  async getLatestMessage(query) {
    const ready = await this.ensureReady({ allowCacheFallback: true });
    if (!ready.ok) return ready.message;

    if (!ready.cacheOnly) {
      await this.hydrateGroups();
      mergeSocketStoreMessages();
    }

    const explicitChatQuery = extractExplicitChatQuery(query);
    const inferredType = /\bgroup\b/i.test(String(query || ""))
      ? "group"
      : /\b(dm|dms|direct message|direct messages|personal chat)\b/i.test(String(query || ""))
        ? "dm"
        : "any";

    const chats = resolveCandidateChats(explicitChatQuery, inferredType);
    if (chats.length === 0) {
      return "I could not find a matching WhatsApp chat in the current session.";
    }

    const selected = chats[0];
    let bucket = singleton.messages.get(selected.id) || [];
    if (bucket.length === 0 && !ready.cacheOnly) {
      await pullChatHistoryFromSocket(selected.id, 60);
      bucket = singleton.messages.get(selected.id) || [];
    }

    const latest = bucket
      .filter(item => item && item.text && item.text.trim())
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))[0];

    if (!latest) {
      return `I do not have recent text messages cached for ${selected.name} yet.`;
    }

    await ensureLinkSummariesForChat(selected.id, 20);
    const when = new Date(Number(latest.timestamp || 0) * 1000).toISOString().slice(0, 16).replace("T", " ");
    const response = `Latest message in ${selected.name} at ${when} from ${latest.sender}: ${latest.text}`;

    const recentLines = bucket
      .filter(item => item && item.text && item.text.trim())
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .slice(0, 20)
      .reverse()
      .map(item => {
        const ts = new Date(Number(item.timestamp || 0) * 1000).toISOString().slice(0, 16).replace("T", " ");
        return `[${ts}] ${item.sender}: ${item.text}`;
      });

    const sources = getRecentLinkSources(selected.id, 8);
    rememberSummaryContext({
      chatName: selected.name,
      chatId: selected.id,
      userQuery: query,
      messageLines: recentLines,
      links: sources
    });

    return `${response}${formatSourcesAppendix(sources)}`;
  }

  async summarizeGroupConversation(query) {
    return this.summarizeConversation(`${query} group`);
  }

  async handleFollowUp(input) {
    const pending = singleton.pendingSelection;
    if (!pending) {
      return await answerFromRecentSummaryContext(this.obj, input);
    }

    // Expire stale pending options after 10 minutes.
    if (Date.now() - Number(pending.createdAt || 0) > 10 * 60 * 1000) {
      singleton.pendingSelection = null;
      return { handled: false };
    }

    const idx = selectIndexFromInput(input, pending.options.length);
    if (idx < 0) {
      return { handled: false };
    }

    const selected = pending.options[idx];
    singleton.pendingSelection = null;

    if (!selected?.id) {
      return { handled: true, response: "Invalid selection. Please ask again with the full chat name." };
    }

    const ready = await this.ensureReady({ allowCacheFallback: true });
    if (!ready.ok) {
      return { handled: true, response: ready.message };
    }

    if (!ready.cacheOnly) {
      await this.hydrateGroups();
      mergeSocketStoreMessages(selected.id);
      await pullChatHistoryFromSocket(selected.id, Math.max(60, Number(pending.maxMessages || 40)));
    }

    const bucket = singleton.messages.get(selected.id) || [];
    const maxMessages = Math.max(5, Math.min(120, Number(pending.maxMessages) || 40));
    const messages = bucket
      .filter(item => item.text && item.text.trim())
      .slice(-maxMessages)
      .map(item => {
        const when = new Date(Number(item.timestamp || 0) * 1000).toISOString().slice(0, 16).replace("T", " ");
        return `[${when}] ${item.sender}: ${item.text}`;
      });

    if (messages.length === 0) {
      return {
        handled: true,
        response: `I do not have recent text messages cached for ${selected.name} yet.`
      };
    }

    const summarizePrompt =
`You summarize WhatsApp conversations.
Output plain text only, concise, and accurate.
User query: ${JSON.stringify(pending.query || "")}
Chat: ${selected.name}
Messages:\n${messages.join("\n")}${formatLinksForPrompt(selected.id)}
`;

    try {
      const response = await this.obj.customQuery(summarizePrompt);
      const sources = getRecentLinkSources(selected.id, 8);
      rememberSummaryContext({
        chatName: selected.name,
        chatId: selected.id,
        userQuery: pending.query || "",
        messageLines: messages,
        links: sources
      });
      return { handled: true, response: `${response}${formatSourcesAppendix(sources)}` };
    } catch (err) {
      return {
        handled: true,
        response: `Failed to summarize chat conversation: ${String(err?.message || err)}`
      };
    }
  }
}

module.exports = WhatsAppPlugin;
