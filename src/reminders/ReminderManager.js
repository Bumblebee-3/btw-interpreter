const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const { execFile } = require("child_process");
const chrono = require("chrono-node");

const execFileAsync = promisify(execFile);

function escapeRegExp(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseClockTime(input) {
  const raw = String(input || "");

  let match = raw.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (match) {
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const meridiem = String(match[3] || "").toLowerCase();

    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;

    return {
      hour,
      minute,
      matchedText: match[0]
    };
  }

  match = raw.match(/\bat\s+(\d{1,2})(?::(\d{2}))\b/i);
  if (match) {
    return {
      hour: Number(match[1]),
      minute: Number(match[2] || 0),
      matchedText: match[0]
    };
  }

  return null;
}

function parseExplicitDateDMY(input) {
  const raw = String(input || "");
  const dateMatch = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (!dateMatch) return null;

  const day = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const year = Number(dateMatch[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const clock = parseClockTime(raw);
  const due = new Date(year, month - 1, day, clock ? clock.hour : 9, clock ? clock.minute : 0, 0, 0);
  if (Number.isNaN(due.getTime())) {
    return null;
  }

  return {
    due,
    matchedChunks: [dateMatch[0], ...(clock ? [clock.matchedText] : [])]
  };
}

function extractReminderText(input, matchedChunks) {
  let working = String(input || "").trim();

  working = working.replace(/^\s*please\s+/i, "");
  working = working.replace(/^\s*remind\s+me\s*/i, "");
  working = working.replace(/^\s*(to|about)\s+/i, "");

  for (const chunk of matchedChunks || []) {
    if (!chunk) continue;
    const re = new RegExp(escapeRegExp(chunk), "i");
    working = working.replace(re, " ");
  }

  working = working
    .replace(/\b(in|at|on)\s*$/i, "")
    .replace(/^[,.:\-\s]+/, "")
    .replace(/[,.:\-\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  return working;
}

function snoozeMsFromChoice(choice) {
  switch (choice) {
    case "snooze_5m":
      return 5 * 60 * 1000;
    case "snooze_10m":
      return 10 * 60 * 1000;
    case "snooze_1h":
      return 60 * 60 * 1000;
    case "snooze_1d":
      return 24 * 60 * 60 * 1000;
    case "snooze_1w":
      return 7 * 24 * 60 * 60 * 1000;
    default:
      return 0;
  }
}

function getDynamicSnoozeChoices(reminder) {
  const createdAtMs = new Date(reminder?.createdAt || 0).getTime();
  const lastSnoozedAtMs = new Date(reminder?.lastSnoozedAt || 0).getTime();
  const dueAtMs = new Date(reminder?.dueAt || 0).getTime();

  // Prefer the most recent scheduling anchor (last snooze) to infer user intent.
  const baseMs = Number.isFinite(lastSnoozedAtMs) && lastSnoozedAtMs > 0
    ? lastSnoozedAtMs
    : createdAtMs;
  const intervalMs = dueAtMs - baseMs;

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return ["snooze_5m", "snooze_10m", "snooze_1h", "snooze_1d", "snooze_1w"];
  }

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (intervalMs < 30 * minute) {
    return ["snooze_5m", "snooze_10m"];
  }

  if (intervalMs < 6 * hour) {
    return ["snooze_10m", "snooze_1h"];
  }

  if (intervalMs < 2 * day) {
    return ["snooze_1h", "snooze_1d"];
  }

  return ["snooze_1d", "snooze_1w"];
}

class ReminderManager {
  constructor(options = {}) {
    this.storagePath = options.storagePath || path.join(process.cwd(), "plugins", "reminder", "reminders.json");
    this.notifyScriptPath = options.notifyScriptPath || path.join(process.cwd(), "src", "scripts", "reminder_notify.sh");
    this.pollIntervalMs = Number(options.pollIntervalMs || 15000);

    this.reminders = [];
    this.timer = null;
    this.processing = false;
    this.loaded = false;
  }

  init() {
    if (this.loaded) return;

    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    if (!fs.existsSync(this.storagePath)) {
      fs.writeFileSync(this.storagePath, JSON.stringify({ reminders: [] }, null, 2));
    }

    this.load();
    this.loaded = true;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.storagePath, "utf-8");
      const parsed = JSON.parse(raw);
      const reminders = Array.isArray(parsed?.reminders) ? parsed.reminders : [];

      this.reminders = reminders.filter(r => r && r.id && r.text && r.dueAt && r.status);
    } catch (_) {
      this.reminders = [];
    }
  }

  save() {
    fs.writeFileSync(this.storagePath, JSON.stringify({ reminders: this.reminders }, null, 2));
  }

  start() {
    this.init();
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.pollIntervalMs);

    this.tick().catch(() => {});
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  parseReminderInput(input) {
    const raw = String(input || "").trim();
    if (!raw) {
      return { ok: false, message: "Please provide reminder details." };
    }

    if (!/^\s*remind\s+me\b/i.test(raw)) {
      return {
        ok: false,
        message: "Use reminder format like: remind me about rent in 5 minutes."
      };
    }

    let due = null;
    let matchedChunks = [];

    const explicitDMY = parseExplicitDateDMY(raw);
    if (explicitDMY) {
      due = explicitDMY.due;
      matchedChunks = explicitDMY.matchedChunks;
    } else {
      const parsed = chrono.parse(raw, new Date(), { forwardDate: true });
      if (!parsed || parsed.length === 0) {
        return {
          ok: false,
          message: "I couldn't parse reminder time. Try phrases like 'in 10 minutes', 'at 12am on monday', or 'on 02/06/2026 at 12am'."
        };
      }

      const best = parsed[0];
      due = best.start.date();
      matchedChunks = [best.text];
    }

    if (!(due instanceof Date) || Number.isNaN(due.getTime())) {
      return {
        ok: false,
        message: "I couldn't parse reminder time. Please try again with a clearer date or time."
      };
    }

    if (due.getTime() <= Date.now()) {
      return {
        ok: false,
        message: "Reminder time must be in the future."
      };
    }

    const text = extractReminderText(raw, matchedChunks);
    if (!text) {
      return {
        ok: false,
        message: "Please tell me what to remind you about."
      };
    }

    return {
      ok: true,
      due,
      text
    };
  }

  addReminderFromInput(input) {
    this.init();

    const parsed = this.parseReminderInput(input);
    if (!parsed.ok) {
      return parsed;
    }

    const reminder = {
      id: crypto.randomUUID(),
      text: parsed.text,
      dueAt: parsed.due.toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
      snoozedCount: 0
    };

    this.reminders.push(reminder);
    this.save();

    return {
      ok: true,
      reminder
    };
  }

  async showReminder(reminder) {
    const title = "Bumblebee Reminder";
    const body = reminder.text;

    if (!fs.existsSync(this.notifyScriptPath)) {
      return "dismiss";
    }

    try {
      const allowedChoices = getDynamicSnoozeChoices(reminder);
      const result = await execFileAsync(this.notifyScriptPath, [title, body, allowedChoices.join(",")], {
        timeout: 180000
      });
      const out = String(result.stdout || "").trim().toLowerCase();
      return out || "dismiss";
    } catch (_) {
      return "dismiss";
    }
  }

  async tick() {
    this.init();
    if (this.processing) return;

    this.processing = true;
    try {
      const now = Date.now();
      const due = this.reminders
        .filter(r => r.status === "pending" && new Date(r.dueAt).getTime() <= now)
        .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());

      if (due.length === 0) {
        return;
      }

      for (const reminder of due) {
        const choice = await this.showReminder(reminder);
        if (choice === "dismiss") {
          reminder.status = "done";
          reminder.completedAt = new Date().toISOString();
          continue;
        }

        const snoozeMs = snoozeMsFromChoice(choice);
        if (snoozeMs > 0) {
          reminder.dueAt = new Date(Date.now() + snoozeMs).toISOString();
          reminder.snoozedCount = Number(reminder.snoozedCount || 0) + 1;
          reminder.lastSnoozedAt = new Date().toISOString();
          continue;
        }

        // Unknown choice defaults to dismiss so reminders don't loop forever.
        reminder.status = "done";
        reminder.completedAt = new Date().toISOString();
      }

      this.save();
    } finally {
      this.processing = false;
    }
  }
}

module.exports = ReminderManager;
