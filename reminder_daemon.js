require("dotenv").config();

const fs = require("fs");
const path = require("path");
const ReminderManager = require("./src/reminders/ReminderManager");

function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file at ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw);
}

function startReminderDaemon() {
  const config = loadConfig();
  const reminderConfig = config?.plugins?.reminder || {};

  const manager = new ReminderManager({
    storagePath: reminderConfig.storage_path,
    pollIntervalMs: reminderConfig.poll_interval_ms
  });

  manager.start();

  const poll = Number(reminderConfig.poll_interval_ms || 15000);
  console.log(`[ReminderDaemon] Running. Poll interval: ${poll}ms`);
  console.log("[ReminderDaemon] Press Ctrl+C to stop.");

  const shutdown = () => {
    console.log("\n[ReminderDaemon] Shutting down...");
    manager.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

try {
  startReminderDaemon();
} catch (error) {
  console.error("[ReminderDaemon] Failed to start:", error.message);
  process.exit(1);
}
