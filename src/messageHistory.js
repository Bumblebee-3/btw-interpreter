const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'message_history.json');

const state = {
  messages: [], // { id, source, sourceId, threadId, text, links, timestamp, meta }
  lastSavedAt: 0
};

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {}
}

function load() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
    const parsed = JSON.parse(raw || '{}');
    state.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch (_) {
    // ignore
  }
}

function save() {
  try {
    ensureDir();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ messages: state.messages }, null, 2));
    state.lastSavedAt = Date.now();
  } catch (err) {
    // best-effort
    console.warn('[messageHistory] save failed:', err?.message || err);
  }
}

function scheduleSave(ms = 700) {
  if (state._saveTimer) return;
  state._saveTimer = setTimeout(() => {
    state._saveTimer = null;
    save();
  }, ms);
}

function makeId(prefix = 'm') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now()}`;
}

/**
 * Add a message to history. message: { source, sourceId, threadId, text, links, timestamp, meta }
 */
function addMessage(message = {}) {
  try {
    if (!message || !message.source) return null;

    const msg = {
      id: String(message.id || message.sourceId || makeId(message.source)).trim(),
      source: String(message.source || 'unknown'),
      sourceId: String(message.sourceId || message.id || ''),
      threadId: message.threadId || null,
      text: String(message.text || message.body || message.snippet || '').trim(),
      links: Array.isArray(message.links) ? message.links.slice(0, 20) : [],
      timestamp: Number(message.timestamp || Math.floor(Date.now() / 1000)),
      meta: message.meta || {}
    };

    // dedupe by id
    const exists = state.messages.find(m => m.id === msg.id && m.source === msg.source);
    if (exists) return exists;

    state.messages.push(msg);
    // keep last 1000 messages globally to limit growth
    if (state.messages.length > 1000) state.messages.splice(0, state.messages.length - 1000);

    scheduleSave();
    return msg;
  } catch (err) {
    return null;
  }
}

function getLatestBySource(source, opts = {}) {
  if (!source) return null;
  const list = state.messages.filter(m => m.source === source);
  if (list.length === 0) return null;
  const sorted = list.slice().sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  if (opts.filter && typeof opts.filter === 'function') return sorted.find(opts.filter) || null;
  return sorted[0] || null;
}

function getLatestGlobal(opts = {}) {
  if (!state.messages.length) return null;
  const sorted = state.messages.slice().sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  if (opts.filter && typeof opts.filter === 'function') return sorted.find(opts.filter) || null;
  return sorted[0] || null;
}

function findById(id, source) {
  if (!id) return null;
  return state.messages.find(m => m.id === id && (source ? m.source === source : true)) || null;
}

function getLastLinkForSource(source) {
  if (!source) return null;
  const list = state.messages.filter(m => m.source === source && Array.isArray(m.links) && m.links.length > 0);
  if (!list.length) return null;
  const sorted = list.slice().sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  return { message: sorted[0], link: sorted[0].links[sorted[0].links.length - 1] };
}

// init load
load();

module.exports = {
  addMessage,
  getLatestBySource,
  getLatestGlobal,
  findById,
  getLastLinkForSource,
  _raw: state
};
