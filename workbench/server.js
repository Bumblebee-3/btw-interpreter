const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PDFParse } = require("pdf-parse");
const MessageHistory = require("../src/interpreter/messageHistory.js");
const { Interpreter, resolveLlmConfig } = require("../src/index.js");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(__dirname, "data");
const sessionsPath = path.join(dataDir, "sessions.json");
const uploadsDir = path.join(dataDir, "uploads");
const ragSourcesPath = path.join(dataDir, "rag-sources.json");
const crawlJobsPath = path.join(dataDir, "crawl-jobs.json");
dotenv.config({ path: path.join(root, ".env") });
const config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
const workbenchConfig = config.workbench || {};
const app = express();
const sessions = new Map();
const crawlJobs = new Map();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

function id() {
  return crypto.randomUUID();
}

function loadSessions() {
  try {
    const saved = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    Object.values(saved).forEach(session => {
      sessions.set(session.id, { ...session, feedback: session.feedback || [], files: new Map(), aborted: false });
    });
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("[workbench] Could not load sessions:", error.message);
  }
}

function saveSessions() {
  fs.mkdirSync(dataDir, { recursive: true });
  const saved = {};
  for (const [sessionId, session] of sessions) {
    saved[sessionId] = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      history: session.history,
      feedback: session.feedback || []
    };
  }
  const temporaryPath = `${sessionsPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(saved, null, 2));
  fs.renameSync(temporaryPath, sessionsPath);
}

function sessionMetadata(session) {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.history.length
  };
}

function serializeResult(result) {
  try {
    return JSON.stringify(result, (_, value) => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "function") return undefined;
      return value;
    });
  } catch (_) {
    return JSON.stringify({ type: "unserializable", content: String(result) });
  }
}

function readRagSources() {
  try { return JSON.parse(fs.readFileSync(ragSourcesPath, "utf8")); }
  catch (_) { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(ragSourcesPath, "[]"); return []; }
}

function writeRagSources(sources) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(ragSourcesPath, JSON.stringify(sources, null, 2));
}

function addRagSource(record) {
  const sources = readRagSources().filter(source => source.source !== record.source);
  sources.push({ id: crypto.randomUUID(), ...record, addedAt: Date.now() });
  writeRagSources(sources);
}

function resolveTableName(value) {
  const table = String(value || "documents").trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(table)) {
    throw new Error("Table names must start with a letter and contain only letters, numbers, underscores, or hyphens.");
  }
  return table;
}

function saveCrawlJobs() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(crawlJobsPath, JSON.stringify(Object.fromEntries(crawlJobs), null, 2));
}

function loadCrawlJobs() {
  try {
    const saved = JSON.parse(fs.readFileSync(crawlJobsPath, "utf8"));
    Object.values(saved).forEach(job => {
      if (job.status === "running") job.status = "queued";
      crawlJobs.set(job.id, job);
    });
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("[workbench] Could not load crawl jobs:", error.message);
  }
}

function updateCrawlJob(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  crawlJobs.set(job.id, job);
  saveCrawlJobs();
}

async function runCrawlJob(job) {
  updateCrawlJob(job, { status: "running", current: "Preparing scan" });
  try {
    await interpreter.db.deleteBySource(job.table, job.url);
    const result = await interpreter.db.addUrlToTable(job.table, job.url, {
      maxPages: job.maxPages,
      maxDepth: job.maxDepth,
      prefix: job.prefix,
      onProgress: event => {
        updateCrawlJob(job, {
          current: event.status === "fetched" ? `Fetched ${event.url}` : `Skipped ${event.url}`,
          lastUrl: event.url,
          lastStatus: event.status,
          lastReason: event.reason || "",
          fetchedPages: event.status === "fetched" ? (job.fetchedPages || 0) + 1 : job.fetchedPages || 0,
          skippedPages: event.status === "skipped" ? (job.skippedPages || 0) + 1 : job.skippedPages || 0,
          fetchedChars: (job.fetchedChars || 0) + (event.chars || 0)
        });
      }
    });
    addRagSource({ type: "url", source: job.url, label: job.label, table: job.table, chunks: result.inserted, pages: result.pages, prefix: job.prefix });
    updateCrawlJob(job, { status: "completed", current: `Completed: fetched ${job.fetchedPages || result.pages} page(s)`, indexedChunks: result.inserted, fetchedPages: result.pages });
  } catch (error) {
    updateCrawlJob(job, { status: "failed", current: "Scan failed", error: error.message });
  }
}

function startQueuedCrawlJobs() {
  for (const job of crawlJobs.values()) if (job.status === "queued") runCrawlJob(job);
}

loadSessions();
loadCrawlJobs();

function createInterpreter() {
  const interpreter = new Interpreter({ llm_config: resolveLlmConfig(config) });
  config.plugins.tavily.tavily_api_key ||= process.env.tapi || "";
  config.plugins.weather.weather_api_key ||= process.env.wapi || "";
  config.plugins.gmail.obj = interpreter;
  config.plugins.calendar.obj = interpreter;
  if (config.plugins.whatsapp) config.plugins.whatsapp.obj = interpreter;
  if (config.plugins.browser) config.plugins.browser.obj = interpreter;
  if (config.plugins.reminder?.enabled) {
    interpreter.initReminderSystem({
      storagePath: config.plugins.reminder.storage_path,
      notifyScriptPath: path.join(root, "src/scripts/reminder_notify.sh"),
      pollIntervalMs: config.plugins.reminder.poll_interval_ms
    });
    config.plugins.reminder.reminder_manager = interpreter.reminderManager;
  }
  interpreter.loadCommands(path.join(root, "commands.json"));
  interpreter.loadPlugins("weather", config.plugins.weather);
  interpreter.loadPlugins("calendar", config.plugins.calendar);
  interpreter.loadPlugins("gmail", config.plugins.gmail, process.env.email);
  interpreter.loadPlugins("tavily", config.plugins.tavily);
  if (config.plugins.whatsapp?.enabled) interpreter.loadPlugins("whatsapp", config.plugins.whatsapp);
  if (config.plugins.browser?.enabled) interpreter.loadPlugins("browser", config.plugins.browser);
  if (config.plugins.reminder?.enabled) interpreter.loadPlugins("reminder", config.plugins.reminder);
  interpreter.loadDB(config.rag.location, config.rag.table_limit);
  if (config.plugins.rag_manager?.enabled) {
    config.plugins.rag_manager.db = interpreter.db;
    config.plugins.rag_manager.data_dir = config.plugins.rag_manager.data_dir || uploadsDir;
    interpreter.loadPlugins("rag-manager", config.plugins.rag_manager);
  }
  return interpreter;
}

const interpreter = createInterpreter();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function getSession(sessionId) {
  return sessionId && sessions.get(sessionId);
}

function sendEvent(response, payload) {
  if (!response.writableEnded) response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

app.post("/api/session/new", (req, res) => {
  const sessionId = id();
  const now = Date.now();
  const session = { id: sessionId, title: "New conversation", createdAt: now, updatedAt: now, history: [], feedback: [], files: new Map(), aborted: false };
  sessions.set(sessionId, session);
  res.json({ sessionId, ...sessionMetadata(session) });
});

app.get("/api/sessions", (req, res) => {
  const metadata = [...sessions.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map(sessionMetadata);
  res.json(metadata);
});

app.get("/api/rag/sources", (req, res) => res.json(readRagSources()));

app.get("/api/rag/tables", async (req, res) => {
  try {
    res.json(await interpreter.db.getAllTables());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/rag/text", async (req, res) => {
  const { text, label = "Text note", table: requestedTable = "documents" } = req.body || {};
  if (!String(text || "").trim()) return res.status(400).json({ error: "Enter some text to add." });
  try {
    const table = resolveTableName(requestedTable);
    await interpreter.db.ensureTable(table);
    await interpreter.db.addToTable(table, String(text).trim());
    addRagSource({ type: "text", source: `text:${crypto.randomUUID()}`, label, table, chunks: 1, prefix: "" });
    res.json({ ok: true, table });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/rag/crawl-jobs", (req, res) => {
  res.json([...crawlJobs.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 20));
});

app.get("/api/rag/crawl-jobs/:id", (req, res) => {
  const job = crawlJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Crawl job not found" });
  res.json(job);
});

app.delete("/api/rag/tables/:table", async (req, res) => {
  let table;
  try { table = resolveTableName(req.params.table); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (table === "documents") return res.status(400).json({ error: "The default documents table cannot be deleted." });
  try {
    await interpreter.db.deleteTable(table);
    const sources = readRagSources();
    writeRagSources(sources.filter(source => source.table !== table));
    res.json({ ok: true, removed: table });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/rag/sources/:id", async (req, res) => {
  const sources = readRagSources();
  const entry = sources.find(source => source.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Source not found" });
  await interpreter.db.deleteBySource(entry.table, entry.source);
  writeRagSources(sources.filter(source => source.id !== entry.id));
  res.json({ ok: true, removed: entry.label });
});

app.post("/api/rag/scan-url", async (req, res) => {
  const { url, label, maxPages: requestedMaxPages = 1, maxDepth: requestedMaxDepth = 0, table: requestedTable = "documents" } = req.body || {};
  if (!/^https?:\/\//i.test(String(url || ""))) return res.status(400).json({ error: "Please provide a valid http(s) URL" });
  let table;
  try { table = resolveTableName(requestedTable); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  try {
    const prefix = `${label || new URL(url).hostname}: `;
    const maxPages = Number(requestedMaxPages);
    const maxDepth = Number(requestedMaxDepth);
    if (!Number.isInteger(maxPages) || maxPages < 0 || !Number.isInteger(maxDepth) || maxDepth < -1) {
      return res.status(400).json({ error: "maxPages must be 0 or greater and maxDepth must be -1 or greater." });
    }
    const job = { id: id(), status: "queued", url, label: label || new URL(url).hostname, table, maxPages, maxDepth, prefix, fetchedPages: 0, skippedPages: 0, fetchedChars: 0, indexedChunks: 0, createdAt: Date.now(), updatedAt: Date.now() };
    crawlJobs.set(job.id, job);
    saveCrawlJobs();
    runCrawlJob(job);
    res.status(202).json({ ok: true, jobId: job.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  const session = getSession(req.body.sessionId);
  if (!session) return res.status(400).json({ error: "Invalid session" });
  if (!req.file) return res.status(400).json({ error: "No file supplied" });

  const file = req.file;
  fs.mkdirSync(uploadsDir, { recursive: true });
  const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(uploadsDir, `${crypto.randomUUID()}_${safeName}`);
  fs.writeFileSync(filePath, file.buffer);
  const extension = path.extname(file.originalname).toLowerCase();
  const allowedExtensions = new Set([".txt", ".json", ".md", ".js", ".ts", ".py", ".rs", ".cpp", ".h", ".toml", ".sh", ".pdf", ".csv"]);
  const accepted = file.mimetype.startsWith("text/") || file.mimetype === "application/json" ||
    file.mimetype === "application/pdf" || file.mimetype.startsWith("image/") || allowedExtensions.has(extension);
  if (!accepted) return res.status(415).json({ error: "Unsupported file type" });

  let content;
  if (file.mimetype === "application/pdf" || extension === ".pdf") {
    const parser = new PDFParse({ data: file.buffer });
    const parsed = await parser.getText();
    await parser.destroy();
    content = parsed.text || "PDF has no extractable text";
  } else if (file.mimetype.startsWith("image/")) {
    content = file.buffer.toString("base64");
  } else {
    content = file.buffer.toString("utf8");
  }
  const fileId = id();
  session.files.set(fileId, { name: file.originalname, mimeType: file.mimetype, content, size: file.size, filePath });
  if (req.body.context === "dataset") {
    try {
      const table = resolveTableName(req.body.table || "documents");
      const result = await interpreter.db.addFileToTable(table, filePath, { prefix: `${file.originalname}: ` });
      addRagSource({ type: "file", source: filePath, label: file.originalname, originalName: file.originalname, table, chunks: result.inserted, prefix: `${file.originalname}: ` });
      return res.json({ fileId, name: file.originalname, filePath, size: file.size, type: file.mimetype, preview: content.slice(0, 200), indexed: true, inserted: result.inserted });
    } catch (error) {
      return res.status(422).json({ error: error.message });
    }
  }
  res.json({ fileId, name: file.originalname, filePath, size: file.size, type: file.mimetype, preview: content.slice(0, 200) });
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, message = "", fileIds = [], regenerate = false, assistantIndex = null } = req.body || {};
  const session = getSession(sessionId);
  if (!session) return res.status(400).json({ error: "Session not found" });
  const files = fileIds.map(fileId => session.files.get(fileId)).filter(Boolean);
  const fileContext = files.map(file => `\n\n[Attached file: ${file.name}]\n${file.mimeType.startsWith("image/") ? "(Image attached)" : file.content}`).join("");
  const scanIntent = /\b(scan|index|ingest|add|remember|learn|read|save)\b/i.test(message) && /\b(file|document|pdf|this|knowledge base)\b/i.test(message);
  const fileTags = scanIntent ? files.map(file => `\n[FILE:path=${file.filePath},name=${file.name}]`).join("") : "";
  const input = `${String(message).trim()}${fileContext}${fileTags}`.trim() || "[User attached files]";

  res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  session.aborted = false;
  const previousHistory = interpreter.messageHistory;
  const history = new MessageHistory(20);
  for (let index = 0; index < session.history.length; index += 2) {
    const userTurn = session.history[index];
    const assistantTurn = session.history[index + 1];
    if (userTurn?.role === "user" && assistantTurn?.role === "assistant") {
      history.addTurn({
        timestamp: "earlier",
        userQuery: userTurn.content,
        toolName: null,
        rawToolData: null,
        llmFormattedResult: assistantTurn.content,
        responseType: "text"
      });
    }
  }
  interpreter.messageHistory = history;
  try {
    const startedAt = Date.now();
    const result = await interpreter.processMessage(input, session.history, { workbench: true, sessionId });
    const durationMs = Date.now() - startedAt;
    const fullResponse = typeof result === "string" ? result : result?.content || JSON.stringify(result);
    const rawResult = serializeResult(result) || "null";
    const serializedPlugins = serializeResult(result?.plugins || []);
    const meta = {
      query: message,
      durationMs,
      plugins: JSON.parse(serializedPlugins || "[]"),
      rawResult,
      model: interpreter.llm_config?.models?.default || "unknown",
      tokenEstimate: Math.ceil(String(fullResponse).length / 4),
      completedAt: Date.now()
    };
    if (!session.aborted) {
      const persistedMeta = { ...meta, rawResult: JSON.parse(rawResult) };
      let versionIndex = 0;
      let versionCount = 1;
      if (regenerate && Number.isInteger(assistantIndex) && session.history[assistantIndex]?.role === "assistant") {
        const assistantEntry = session.history[assistantIndex];
        const versions = Array.isArray(assistantEntry.versions)
          ? assistantEntry.versions
          : [{ content: assistantEntry.content, meta: assistantEntry.meta || {} }];
        versions.push({ content: fullResponse, meta: persistedMeta });
        versionIndex = versions.length - 1;
        versionCount = versions.length;
        assistantEntry.versions = versions;
        assistantEntry.versionIndex = versionIndex;
        assistantEntry.content = fullResponse;
        assistantEntry.meta = persistedMeta;
      } else {
        session.history.push({ role: "user", content: message, files: files.map(file => file.name) });
        session.history.push({ role: "assistant", content: fullResponse, meta: persistedMeta, versions: [{ content: fullResponse, meta: persistedMeta }], versionIndex: 0 });
      }
      meta.versionIndex = versionIndex;
      meta.versionCount = versionCount;
      persistedMeta.versionIndex = versionIndex;
      persistedMeta.versionCount = versionCount;
      if (regenerate && session.history[assistantIndex]?.role === "assistant") {
        session.history[assistantIndex].meta = persistedMeta;
      }
      sendEvent(res, { type: "token", content: fullResponse });
      sendEvent(res, { type: "done", fullResponse, meta });
      if (session.history.length === 2) {
        const firstMessage = String(message || "").replace(/[\r\n]+/g, " ").trim();
        session.title = firstMessage
          ? firstMessage.slice(0, 40)
          : `File upload — ${files[0]?.name || "attachment"}`;
      }
      session.updatedAt = Date.now();
      saveSessions();
    }
  } catch (error) {
    sendEvent(res, { type: "error", message: error.message || "Interpreter failed" });
  } finally {
    interpreter.messageHistory = previousHistory;
    res.end();
  }
});

app.get("/api/session/:sessionId", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(400).json({ error: "Session not found" });
  res.json({ id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, history: session.history, feedback: session.feedback || [] });
});

app.get("/api/session/:sessionId/history", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(400).json({ error: "Session not found" });
  res.json(session.history);
});

app.delete("/api/session/:sessionId", (req, res) => {
  sessions.delete(req.params.sessionId);
  saveSessions();
  res.json({ ok: true });
});

app.post("/api/session/:sessionId/feedback", (req, res) => {
  const session = getSession(req.params.sessionId);
  const { messageIndex, rating } = req.body || {};
  if (!session) return res.status(400).json({ error: "Session not found" });
  if (!Number.isInteger(messageIndex) || !["up", "down"].includes(rating)) {
    return res.status(400).json({ error: "Invalid feedback" });
  }
  session.feedback = (session.feedback || []).filter(item => item.messageIndex !== messageIndex);
  session.feedback.push({ messageIndex, rating, timestamp: Date.now() });
  saveSessions();
  res.json({ ok: true });
});

app.post("/api/session/:sessionId/version", (req, res) => {
  const session = getSession(req.params.sessionId);
  const { assistantIndex, versionIndex } = req.body || {};
  const entry = session?.history?.[assistantIndex];
  if (!session) return res.status(400).json({ error: "Session not found" });
  if (!entry || entry.role !== "assistant" || !Array.isArray(entry.versions) || !entry.versions[versionIndex]) {
    return res.status(400).json({ error: "Invalid response version" });
  }
  entry.versionIndex = versionIndex;
  entry.content = entry.versions[versionIndex].content;
  entry.meta = { ...entry.versions[versionIndex].meta, versionIndex, versionCount: entry.versions.length };
  entry.versions[versionIndex].meta = entry.meta;
  session.updatedAt = Date.now();
  saveSessions();
  res.json({ ok: true, content: entry.content, meta: entry.meta });
});

app.post("/api/abort/:sessionId", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(400).json({ error: "Session not found" });
  session.aborted = true;
  res.json({ ok: true });
});

const port = Number(process.env.WORKBENCH_PORT || workbenchConfig.port) || 4891;
const server = app.listen(port, "127.0.0.1", () => console.log(`BTW Workbench listening at http://127.0.0.1:${port}`));
startQueuedCrawlJobs();

function shutdown() {
  saveSessions();
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
