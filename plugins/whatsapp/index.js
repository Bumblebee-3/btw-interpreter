const fs = require("fs");
const path = require("path");
const baileys = require("baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const { extractContent, extractLinksFromText, formatExtractedContent, detectPlatform } = require("../../src/contentExtractor");

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
  lastActiveChat: null,
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
  const contextualMessageText = String(messageText || "")
    .replace(/https?:\/\/[^\s]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

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
      const hasRichExtraction = Boolean(contentText && contentText.replace(/\[[^\]]+\]/g, "").trim().length > 25);
      const fallbackSummary = contextualMessageText
        ? `Shared with note: ${contextualMessageText}`
        : `Link shared without extra message text. URL: ${url}`;
      const finalSummary = hasRichExtraction
        ? contentText
        : `${contentText ? `${contentText}\n` : ""}${fallbackSummary}`.trim();
      const finalTitle = extracted.title || (contextualMessageText ? contextualMessageText.slice(0, 120) : "");

      bucket.push({
        url,
        platform: extracted.platform || "generic",
        title: finalTitle,
        summary: finalSummary.substring(0, 2000), // Limit to 2000 chars
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

function getChatLinkSources(jid, limit = 20) {
  if (!jid) return [];
  const bucket = singleton.linkSummaries.get(jid) || [];
  return bucket
    .slice(-Math.max(1, Number(limit) || 20))
    .map(item => ({
      url: item.url,
      platform: item.platform || "generic",
      title: item.title || "",
      summary: String(item.summary || "").slice(0, 1200),
      sender: item.sender || "unknown",
      timestamp: Number(item.timestamp || 0)
    }));
}

function normalizeUrlForMatch(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const removeKeys = ["fbclid", "gclid", "igshid", "sfnsn", "mc_cid", "mc_eid"];
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/^utm_/i.test(key) || removeKeys.includes(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = "";
    const normalized = parsed.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch (_) {
    return raw.replace(/[?#].*$/, "").replace(/\/$/, "");
  }
}

function mergeLinkSources(primary = [], fallback = [], limit = 24) {
  const merged = [];
  const seen = new Set();

  const pushUnique = (item) => {
    if (!item) return;
    const key = normalizeUrlForMatch(item.url || "") || `${String(item.platform || "")}:${String(item.title || "")}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  };

  for (const item of primary || []) pushUnique(item);
  for (const item of fallback || []) pushUnique(item);

  return merged.slice(-Math.max(1, Number(limit) || 24));
}

function getLinkSourcesNearTimestamp(jid, pivotTs, windowSec = 3 * 60 * 60, limit = 6) {
  const bucket = singleton.linkSummaries.get(jid) || [];
  const pivot = Number(pivotTs || 0);
  if (pivot <= 0) return getRecentLinkSources(jid, limit);

  const near = bucket
    .filter(item => Math.abs(Number(item.timestamp || 0) - pivot) <= windowSec)
    .slice(-Math.max(1, Number(limit) || 6));

  if (near.length > 0) {
    return near.map(item => ({
      url: item.url,
      platform: item.platform || "generic",
      title: item.title || "",
      summary: String(item.summary || "").slice(0, 800),
      sender: item.sender || "unknown",
      timestamp: Number(item.timestamp || 0)
    }));
  }

  return getRecentLinkSources(jid, limit);
}

function formatSourcesAppendix(sources = []) {
  if (!Array.isArray(sources) || sources.length === 0) return "";

  const deduped = [];
  const seen = new Set();
  const ordered = [...sources]
    .sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0));

  for (const item of ordered) {
    const key = normalizeUrlForMatch(item?.url || "") || `${String(item?.platform || "")}:${String(item?.title || "")}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= 5) break;
  }

  const cleanSnippet = (value, fallback = "shared update") => {
    const text = String(value || "")
      .replace(/\[[^\]]+\]/g, " ")
      .replace(/\bURL:\s*https?:\/\/\S+/gi, " ")
      .replace(/\bNo preview metadata[^.]*\.?/gi, " ")
      .replace(/\bShared with note:\s*/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text ? text.slice(0, 100) : fallback;
  };

  const labelFor = (source) => {
    const platform = String(source?.platform || "generic").toLowerCase();
    const title = String(source?.title || "").trim();
    const summary = String(source?.summary || "").replace(/\s+/g, " ").trim();
    const sender = String(source?.sender || "someone").trim();
    const domain = extractDomainLabel(source?.url || "");
    const compactTitle = cleanSnippet(title, "");
    const compactSummary = cleanSnippet(summary, "shared update");
    const topic = compactTitle || compactSummary;

    if (platform === "facebook") {
      return topic ? `Facebook link about ${topic}` : `Facebook post shared by ${sender} (preview unavailable)`;
    }
    if (platform === "twitter") {
      return topic ? `Twitter post about ${topic}` : `Twitter/X post shared by ${sender} (preview unavailable)`;
    }
    if (platform === "instagram") {
      return topic ? `Instagram post/reel about ${topic}` : `Instagram post shared by ${sender} (preview unavailable)`;
    }
    if (platform === "youtube") {
      return topic ? `YouTube video on ${topic}` : `YouTube video shared by ${sender}`;
    }

    if (domain && topic) {
      return `${domain} link about ${topic}`;
    }
    if (domain) {
      return `${domain} link shared by ${sender}`;
    }

    return `${platform.toUpperCase()} link: ${topic || `shared by ${sender}`}`;
  };

  const lines = deduped.map((s, idx) => `${idx + 1}. ${labelFor(s)}`);
  return lines.length ? `\n\nRelated sources (newest first):\n${lines.join("\n")}` : "";
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
    followUpHistory: [],
    lastSelectedLink: payload.lastSelectedLink || null
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

function extractDomainLabel(url) {
  try {
    const host = new URL(String(url || "")).hostname.toLowerCase();
    return host.replace(/^www\./, "").split(".").slice(0, 2).join(" ");
  } catch (_) {
    return "";
  }
}

function extractTopicPhrase(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const m = raw.match(/\b(?:about|on|for|of)\s+([a-z0-9][a-z0-9\s\-]{2,80})/i);
  if (m && m[1]) {
    return String(m[1])
      .replace(/\b(it|this|that|one|link|article|post|video)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return "";
}

function tokenizeForLookup(text) {
  const stop = new Set([
    "a", "an", "the", "and", "or", "to", "for", "of", "on", "in", "about", "from",
    "what", "which", "how", "can", "could", "would", "should", "please", "pls", "bruh",
    "look", "lookup", "search", "find", "online", "web", "internet", "google",
    "review", "reviews", "opinion", "opinions", "feedback", "experience", "experiences",
    "no", "mean", "meant", "i", "you", "it", "its", "this", "that", "one", "more"
  ]);

  return normalizeText(text)
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => token.length > 2 && !stop.has(token));
}

function scoreLinkAgainstTokens(link, tokens = []) {
  if (!link || !Array.isArray(tokens) || tokens.length === 0) return 0;
  const haystack = normalizeText(`${link.title || ""} ${link.url || ""} ${link.summary || ""}`);
  if (!haystack) return 0;

  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token.length >= 6 ? 2 : 1;
    }
  }
  return score;
}

function findBestContextLink(ctx, text) {
  const links = Array.isArray(ctx?.links) ? ctx.links : [];
  if (!links.length) return null;

  const tokens = tokenizeForLookup(text);
  if (!tokens.length) return null;

  let best = null;
  let bestScore = 0;
  for (const link of links) {
    const score = scoreLinkAgainstTokens(link, tokens);
    if (score > bestScore) {
      bestScore = score;
      best = link;
    }
  }

  return bestScore > 0 ? best : null;
}

function inferFocusEntity(ctx, input, extraText = "") {
  const explicit = extractTopicPhrase(input);
  if (explicit) return explicit;

  const fromInputMatch = findBestContextLink(ctx, input);
  if (fromInputMatch) {
    return String(fromInputMatch.title || extractDomainLabel(fromInputMatch.url || "") || "").trim();
  }

  const recentLink = ctx?.lastSelectedLink || (Array.isArray(ctx?.links) ? ctx.links[ctx.links.length - 1] : null);
  const fromTitle = String(recentLink?.title || "").trim();
  if (fromTitle) return fromTitle;

  const fromDomain = extractDomainLabel(recentLink?.url || "");
  if (fromDomain) return fromDomain;

  const previousQuestion = String((ctx?.followUpHistory || []).slice(-1)[0]?.question || "").trim();
  if (previousQuestion) {
    const qTopic = extractTopicPhrase(previousQuestion);
    if (qTopic) return qTopic;
    return previousQuestion.replace(/\b(what|which|how|about|the|a|an|is|are|was|were)\b/gi, " ").replace(/\s+/g, " ").trim();
  }

  const prevUser = String(extraText || "").trim();
  if (prevUser) {
    const pTopic = extractTopicPhrase(prevUser);
    if (pTopic) return pTopic;
  }

  return "";
}

function isLikelyContextFollowUp(input) {
  const text = normalizeText(input);
  if (!text) return false;

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasQuestionCue = /\b(what|which|where|when|who|why|how|about|detail|details|explain|summarise|summarize|summary|compare|opinion|recommend|worth|better)\b/i.test(text);
  const hasReferenceCue = /\b(this|that|it|they|them|those|these|one|first|second|third|link|source|post|video|article)\b/i.test(text);
  const hasQuestionMark = /\?/.test(String(input || ""));

  if (hasQuestionCue) return true;
  if (hasReferenceCue && wordCount <= 14) return true;
  if (hasQuestionMark && wordCount <= 18) return true;
  return false;
}

function isDepthExplainFollowUp(input) {
  const text = normalizeText(input);
  if (!text) return false;
  return /\b(explain|in depth|in-depth|indepth|deeper|elaborate|more detail|more details|tell me more|deep dive|go deeper)\b/i.test(text);
}

function sanitizeSummarySnippet(text) {
  return String(text || "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\bURL:\s*https?:\/\/\S+/gi, " ")
    .replace(/\bNo preview metadata[^.]*\.?/gi, " ")
    .replace(/\bShared with note:\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isExplicitWebLookupRequest(input) {
  const text = normalizeText(input);
  if (!text) return false;
  return /(lookup|look up|search|find|web|online|internet|google|research|check|dig up|explore|news|reviews|rating|ratings|comparison|compare|specs|specifications|issues|problems)/i.test(text);
}

function buildContextualLookupQuery(input, ctx, obj) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  const hasPronoun = /\b(it|its|this|that|this one|that one)\b/i.test(raw);
  const prevUser = String(obj?.previousUserQuery || "");
  const focus = inferFocusEntity(ctx, raw, prevUser);

  if (!hasPronoun && !focus) {
    return raw;
  }

  const links = Array.isArray(ctx?.links) ? ctx.links : [];
  const rawMatchedLink = findBestContextLink(ctx, raw);
  const focusNorm = normalizeText(focus);
  const byFocus = links.find(link => {
    if (!focusNorm) return false;
    const title = normalizeText(link?.title || "");
    const url = normalizeText(link?.url || "");
    return (title && title.includes(focusNorm)) || (url && url.includes(focusNorm));
  });

  const selected = rawMatchedLink || byFocus || links[links.length - 1] || null;
  const title = selected ? String(selected.title || "").trim() : "";
  const url = selected ? String(selected.url || "").trim() : "";
  const platform = selected ? String(selected.platform || "generic").toLowerCase() : "generic";
  const rawTokens = tokenizeForLookup(raw);
  const queryAlreadySpecific = rawTokens.length >= 3 || Boolean(rawMatchedLink);

  const fallbackLabel = (byFocus?.title || byFocus?.url || focus || title || url || "item").trim();

  if (queryAlreadySpecific) {
    return raw;
  }

  const intentTokens = [];
  if (/\b(review|reviews|rating|ratings|feedback|opinion|opinions)\b/i.test(raw)) intentTokens.push("reviews", "user feedback");
  if (/\b(compare|comparison|versus|vs|alternative|alternatives)\b/i.test(raw)) intentTokens.push("comparisons", "alternatives");
  if (/\b(issue|issues|problem|problems|bug|bugs|complaint|complaints)\b/i.test(raw)) intentTokens.push("known issues");
  if (/\b(price|pricing|cost|value)\b/i.test(raw)) intentTokens.push("pricing");
  if (/\b(spec|specs|specification|specifications|feature|features|performance|benchmark)\b/i.test(raw)) intentTokens.push("specifications", "performance");
  if (/\b(news|latest|recent|update|updates)\b/i.test(raw)) intentTokens.push("latest updates");

  const uniqueIntent = Array.from(new Set(intentTokens)).slice(0, 4).join(" ");
  if (uniqueIntent) {
    return `${fallbackLabel} ${uniqueIntent}`;
  }

  if (platform === "youtube") {
    return `${fallbackLabel} summary key points credibility`;
  }

  return `${fallbackLabel} overview latest information`;
}

function isExplicitInboxMailRequest(input) {
  const text = normalizeText(input);
  if (!text) return false;
  return /(inbox|gmail|email|emails|mailbox|my mail|my email|unread mail|unread email|new emails|new mail)/i.test(text);
}

function isExplicitPrimaryWhatsAppIntent(input) {
  const text = normalizeText(input);
  if (!text) return false;

  const asksMessagingAction = /(summarise|summarize|summary|latest|last|new|unread|show|get|list|what were|what are)/i.test(text);
  const mentionsMessageDomain = /(message|messages|chat|chats|conversation|conversations|links|link)/i.test(text);
  const hasChatScope = /\b(in|from|of|for|to)\b\s+[a-z0-9@._-]+/i.test(text);
  return asksMessagingAction && mentionsMessageDomain && hasChatScope;
}

function usesPronounChatReference(input) {
  const text = normalizeText(input);
  if (!text) return false;
  return /\b(he|him|his|she|her|they|them|their|that chat|that person|that contact)\b/i.test(text);
}

function rememberActiveChat(chat = {}) {
  if (!chat?.id) return;
  singleton.lastActiveChat = {
    id: chat.id,
    name: chat.name || chat.id,
    isGroup: Boolean(chat.isGroup),
    updatedAt: Date.now()
  };
}

function resolveImplicitChatQuery(query, fallback = "") {
  const explicit = String(fallback || "").trim();
  if (explicit) return explicit;

  if (!usesPronounChatReference(query)) return "";
  const last = singleton.lastActiveChat;
  if (!last?.id) return "";
  if (Date.now() - Number(last.updatedAt || 0) > 60 * 60 * 1000) return "";
  return String(last.name || last.id || "").trim();
}

function selectLinkFromContextByInput(ctx, input) {
  const links = Array.isArray(ctx?.links) ? ctx.links : [];
  if (!links.length) return null;

  const raw = normalizeText(input);
  if (!raw) return links[links.length - 1] || null;

  const tokens = tokenizeForLookup(raw);

  if (/\b(youtube|yt|video)\b/i.test(raw)) {
    const found = links.find(l => String(l.platform || "").toLowerCase() === "youtube" || /youtube|youtu\.be/i.test(String(l.url || "")));
    if (found) return found;
  }
  if (/\b(facebook|fb|post)\b/i.test(raw)) {
    const found = links.find(l => String(l.platform || "").toLowerCase() === "facebook" || /facebook|fb\.com/i.test(String(l.url || "")));
    if (found) return found;
  }
  if (/\b(twitter|x|tweet)\b/i.test(raw)) {
    const found = links.find(l => String(l.platform || "").toLowerCase() === "twitter" || /twitter|x\.com/i.test(String(l.url || "")));
    if (found) return found;
  }
  if (/\b(instagram|insta|reel|ig)\b/i.test(raw)) {
    const found = links.find(l => String(l.platform || "").toLowerCase() === "instagram" || /instagram/i.test(String(l.url || "")));
    if (found) return found;
  }

  if (tokens.length) {
    let best = null;
    let bestScore = 0;
    for (const link of links) {
      const score = scoreLinkAgainstTokens(link, tokens);
      if (score > bestScore) {
        bestScore = score;
        best = link;
      }
    }
    if (best && bestScore > 0) return best;
  }

  // 2) Ordinal mention handling (first/second/third).
  const ordinals = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
  for (const [word, idx] of Object.entries(ordinals)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(raw) && links[idx - 1]) {
      return links[idx - 1];
    }
  }

  // 3) Fallback to latest source.
  return links[links.length - 1] || null;
}

function inferLinksFromMessageLines(lines = []) {
  const collected = [];
  const seen = new Set();

  for (const line of lines) {
    const text = String(line || "");
    if (!text) continue;
    const links = extractLinksFromText(text);
    for (const url of links) {
      const key = normalizeUrlForMatch(url) || url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      collected.push({
        url,
        platform: detectPlatform(url) || "generic",
        title: "",
        summary: "",
        sender: "unknown",
        timestamp: 0
      });
    }
  }

  return collected;
}

function splitIntoSentences(text) {
  if (!text) return [];
  return String(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function trimAtBoundary(text, maxChars) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const cap = Math.max(80, Number(maxChars) || 400);
  if (raw.length <= cap) return raw;

  const slice = raw.slice(0, cap);
  const boundary = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (boundary >= 80) {
    return slice.slice(0, boundary + 1).trim();
  }

  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace >= 60) {
    return `${slice.slice(0, lastSpace).trim()}...`;
  }
  return `${slice.trim()}...`;
}

function extractiveSummarizeText(text, maxSentences = 6) {
  const sentences = splitIntoSentences(text);
  if (!sentences.length) return "";

  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "if", "then", "than", "to", "of", "for", "in", "on", "at", "by", "with", "as", "is", "are", "was", "were", "be", "been", "it", "this", "that", "these", "those", "from", "into", "over", "under", "after", "before", "about", "their", "there", "they", "them", "his", "her", "he", "she", "you", "we", "our", "i"
  ]);

  const termFreq = new Map();
  for (const sentence of sentences) {
    const tokens = sentence.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || [];
    for (const token of tokens) {
      if (stopWords.has(token)) continue;
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }
  }

  const scored = sentences.map((sentence, idx) => {
    const tokens = sentence.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || [];
    const unique = new Set(tokens.filter(t => !stopWords.has(t)));
    let score = 0;
    for (const token of unique) {
      score += termFreq.get(token) || 0;
    }

    if (/\b(dialysis|kidney|risk|warning|cause|symptom|doctor|treatment|study|report|recommend|advice|health)\b/i.test(sentence)) {
      score += 12;
    }
    if (sentence.length >= 90 && sentence.length <= 260) {
      score += 6;
    }

    return { sentence, idx, score };
  });

  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(3, maxSentences))
    .sort((a, b) => a.idx - b.idx)
    .map(s => s.sentence);

  return top.join(" ");
}

async function buildDeterministicSourceSummary(input, selectedLink) {
  if (!selectedLink) return "I could not find a matching shared link in the recent WhatsApp context.";

  const platform = String(selectedLink.platform || "generic").toUpperCase();
  const url = String(selectedLink.url || "").trim();

  let extracted = null;
  if (url) {
    try {
      extracted = await Promise.race([
        extractContent(url),
        new Promise(resolve => setTimeout(() => resolve(null), 10000))
      ]);
    } catch (_) {
      extracted = null;
    }
  }

  const title = String(extracted?.title || selectedLink.title || "").trim();
  const description = String(extracted?.description || "").trim();
  const rawContent = String(extracted?.content || "").trim();
  const cachedSummary = sanitizeSummarySnippet(selectedLink.summary || "");
  const asksDepth = /\b(in depth|deep dive|deeper|elaborate|more detail|more details|explain in depth)\b/i.test(String(input || ""));

  const fullText = [rawContent, description].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const compressed = fullText.length >= 220
    ? extractiveSummarizeText(fullText, asksDepth ? 5 : 2)
    : "";

  const targetChars = asksDepth ? 1500 : 520;
  const shortSummary = compressed
    ? trimAtBoundary(compressed, targetChars)
    : cachedSummary
      ? trimAtBoundary(cachedSummary, targetChars)
      : "I have limited preview metadata for this link right now.";

  if (!compressed && !cachedSummary && String(selectedLink.platform || "").toLowerCase() === "facebook") {
    const who = String(selectedLink.sender || "someone").trim();
    return `I can identify this as a Facebook post shared by ${who}, but Facebook preview content is unavailable in the current extract.`;
  }

  if (title) {
    return `${title}: ${shortSummary}`;
  }

  return `${platform} link summary: ${shortSummary}`;
}

async function answerFromRecentSummaryContext(obj, input) {
  const ctx = singleton.lastSummaryContext;
  if (!ctx) return { handled: false };

  if (isExplicitWebLookupRequest(input)) {
    const rewrittenQuery = buildContextualLookupQuery(input, ctx, obj);
    return { handled: false, rewrittenQuery: rewrittenQuery || String(input || "") };
  }

  if (isExplicitInboxMailRequest(input)) {
    return { handled: false };
  }

  if (isExplicitPrimaryWhatsAppIntent(input)) {
    return { handled: false };
  }

  if (Date.now() - Number(ctx.createdAt || 0) > 30 * 60 * 1000) {
    singleton.lastSummaryContext = null;
    return { handled: false };
  }

  const contextFollowUp = isLikelyContextFollowUp(input);
  const continuationReply = isLikelyContinuationReply(input) && (Date.now() - Number(ctx.lastFollowUpAt || ctx.createdAt || 0) <= 8 * 60 * 1000);
  const depthFollowUp = isDepthExplainFollowUp(input);
  if (!contextFollowUp && !continuationReply && !depthFollowUp) {
    return { handled: false };
  }

  const normalizedInput = normalizeText(input);
  const contextLinks = Array.isArray(ctx.links) ? ctx.links : [];
  const expandedChatLinks = ctx.chatId ? getChatLinkSources(ctx.chatId, 24) : [];
  const inferredLineLinks = inferLinksFromMessageLines(ctx.messageLines || []);
  const mergedLinks = mergeLinkSources(mergeLinkSources(contextLinks, expandedChatLinks, 24), inferredLineLinks, 30);

  const hasSourceMention = /\b(article|post|link|tweet|reel|video|source|indianexpress|indian express|facebook|instagram|twitter|youtube|x\.com|fb)\b/.test(normalizedInput);
  const hasSummaryAsk = /\b(summarise|summarize|summary|explain)\b/.test(normalizedInput);
  const hasAboutSourceAsk = /\b(what about|tell me about|about that|about the)\b/.test(normalizedInput) && hasSourceMention;
  const isShortSourceReference = hasSourceMention && normalizedInput.split(" ").filter(Boolean).length <= 7;
  const shouldUsePreviousSource = depthFollowUp && !hasSourceMention;
  const wantsDirectSourceSummary = (hasSourceMention && (hasSummaryAsk || hasAboutSourceAsk || isShortSourceReference)) || shouldUsePreviousSource;

  if (wantsDirectSourceSummary) {
    const selectedLink = shouldUsePreviousSource
      ? (ctx.lastSelectedLink || mergedLinks[mergedLinks.length - 1] || null)
      : selectLinkFromContextByInput({ ...ctx, links: mergedLinks }, input);
    if (selectedLink) {
      ctx.lastSelectedLink = selectedLink;
    }
    const response = await buildDeterministicSourceSummary(input, selectedLink);
    appendFollowUpHistory(input, response);
    return { handled: true, response };
  }

  const followUpText = String(input || "");
  const isOpinionQuestion = /(thought|thoughts|thouhgts|opinion|recommend|worth|buy|good|better|should i|which one)/i.test(followUpText);
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
${mergedLinks.map((s, i) => `${i + 1}. platform=${s.platform} title=${s.title} sender=${s.sender} url=${s.url}\nsummary=${s.summary}`).join("\n")}

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

function parseRequestedMessageCount(input, fallback = 1) {
  const raw = String(input || "").toLowerCase();
  const numMatch = raw.match(/\b(?:last|latest|recent|show|get)?\s*(\d{1,2})(?:\s*(?:messages?|msgs?|emssages|messeges))?\b/i);
  if (numMatch) {
    return Math.max(1, Math.min(10, Number(numMatch[1]) || fallback));
  }

  const wordMap = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10
  };

  for (const [word, count] of Object.entries(wordMap)) {
    const pattern = new RegExp(`\\b(?:last|latest|recent|show|get)?\\s*${word}(?:\\s*(?:messages?|msgs?|emssages|messeges))?\\b`, "i");
    if (pattern.test(raw)) {
      return count;
    }
  }

  const loose = raw.match(/\b(?:last|latest|recent)\b[\s\S]{0,20}\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
  if (loose) {
    const token = String(loose[1]).toLowerCase();
    if (/^\d+$/.test(token)) {
      return Math.max(1, Math.min(10, Number(token) || fallback));
    }
    if (Object.prototype.hasOwnProperty.call(wordMap, token)) {
      return wordMap[token];
    }
  }

  return Math.max(1, Math.min(10, Number(fallback) || 1));
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

function extractRecipientLikeTarget(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  const patterns = [
    /\b(?:tell|inform|notify|message|msg|text)\s+([^?.!,\n]+?)(?:\s+that\b|\s+about\b|[?.!,]|$)/i,
    /\blet\s+([^?.!,\n]+?)\s+know\b/i
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    const target = String(match[1] || "")
      .replace(/^the\s+/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (target) return target;
  }

  return "";
}

function formatChatNotFoundMessage(input, chatQuery = "", chatType = "any") {
  const target = String(chatQuery || "").trim() || extractExplicitChatQuery(input) || extractRecipientLikeTarget(input);
  const scope = chatType === "group"
    ? " group"
    : chatType === "dm"
      ? " direct"
      : "";

  if (target) {
    return `I could not find a matching WhatsApp${scope} chat for "${target}" in the current session. Try the exact chat name or phone number.`;
  }

  return `I could not find a matching WhatsApp${scope} chat in the current session. Try a clearer chat/group name.`;
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

  const anchor = singleton.lastActiveChat;
  if (anchor?.id) {
    const ageMs = Date.now() - Number(anchor.updatedAt || 0);
    if (ageMs <= 60 * 60 * 1000) {
      for (const candidate of candidates) {
        if (candidate.id === anchor.id) {
          candidate.score += 0.6;
          break;
        }
      }
      candidates.sort((a, b) => b.score - a.score);
    }
  }

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
    const knownChat = singleton.chats.get(resolved.jid);
    rememberActiveChat({
      id: resolved.jid,
      name: knownChat?.name || resolved.label || resolved.jid,
      isGroup: String(resolved.jid || "").endsWith("@g.us")
    });
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
    const implicitChatQuery = resolveImplicitChatQuery(query, explicitChatQuery);
    if (explicitChatQuery) {
      parsed.chat_query = explicitChatQuery;
    } else if (implicitChatQuery) {
      parsed.chat_query = implicitChatQuery;
    }
    if (/\bgroup\b/i.test(String(query || ""))) {
      parsed.chat_type = "group";
    } else if (/\b(dm|dms|direct message|direct messages|personal chat)\b/i.test(String(query || ""))) {
      parsed.chat_type = "dm";
    }

    const chats = resolveCandidateChats(parsed.chat_query, parsed.chat_type);
    if (chats.length === 0) {
      return formatChatNotFoundMessage(query, parsed.chat_query, parsed.chat_type);
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
    if (scopedChats.length === 1) {
      rememberActiveChat(scopedChats[0]);
    }
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
    const implicitChatQuery = resolveImplicitChatQuery(query, explicitChatQuery);
    if (explicitChatQuery) {
      parsed.chat_query = explicitChatQuery;
    } else if (implicitChatQuery) {
      parsed.chat_query = implicitChatQuery;
    }
    if (/\bgroup\b/i.test(String(query || ""))) {
      parsed.chat_type = "group";
    } else if (/\b(dm|dms|direct message|direct messages|personal chat)\b/i.test(String(query || ""))) {
      parsed.chat_type = "dm";
    }

    const chats = resolveCandidateChats(parsed.chat_query, parsed.chat_type);
    if (chats.length === 0) {
      return formatChatNotFoundMessage(query, parsed.chat_query, parsed.chat_type);
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
    rememberActiveChat(selected);
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
    const implicitChatQuery = resolveImplicitChatQuery(query, explicitChatQuery);
    const inferredType = /\bgroup\b/i.test(String(query || ""))
      ? "group"
      : /\b(dm|dms|direct message|direct messages|personal chat)\b/i.test(String(query || ""))
        ? "dm"
        : "any";

    const chats = resolveCandidateChats(implicitChatQuery || explicitChatQuery, inferredType);
    if (chats.length === 0) {
      return formatChatNotFoundMessage(query, implicitChatQuery || explicitChatQuery, inferredType);
    }

    const requestedCount = parseRequestedMessageCount(query, 1);
    const selected = chats[0];
    rememberActiveChat(selected);
    let bucket = singleton.messages.get(selected.id) || [];
    if (bucket.length === 0 && !ready.cacheOnly) {
      await pullChatHistoryFromSocket(selected.id, 60);
      bucket = singleton.messages.get(selected.id) || [];
    }

    const sortedLatest = bucket
      .filter(item => item && item.text && item.text.trim())
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));

    const latest = sortedLatest[0];

    if (!latest) {
      return `I do not have recent text messages cached for ${selected.name} yet.`;
    }

    await ensureLinkSummariesForChat(selected.id, 20);
    let response;
    if (requestedCount <= 1) {
      const when = new Date(Number(latest.timestamp || 0) * 1000).toISOString().slice(0, 16).replace("T", " ");
      response = `Latest message in ${selected.name} at ${when} from ${latest.sender}: ${latest.text}`;
    } else {
      const picks = sortedLatest.slice(0, requestedCount).reverse();
      const lines = picks.map(item => {
        const when = new Date(Number(item.timestamp || 0) * 1000).toISOString().slice(0, 16).replace("T", " ");
        return `- [${when}] ${item.sender}: ${item.text}`;
      });
      response = `Latest ${picks.length} messages in ${selected.name}:\n${lines.join("\n")}`;
    }

    const recentLines = bucket
      .filter(item => item && item.text && item.text.trim())
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .slice(0, 20)
      .reverse()
      .map(item => {
        const ts = new Date(Number(item.timestamp || 0) * 1000).toISOString().slice(0, 16).replace("T", " ");
        return `[${ts}] ${item.sender}: ${item.text}`;
      });

    const sources = getLinkSourcesNearTimestamp(selected.id, Number(latest.timestamp || 0), 3 * 60 * 60, 6);
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
    rememberActiveChat(selected);

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
