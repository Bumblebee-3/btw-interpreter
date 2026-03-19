require("dotenv").config();

const fs = require("fs");
const path = require("path");
const WhatsAppPlugin = require("./plugins/whatsapp/index");

function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file at ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function start() {
  const config = loadConfig();
  const wa = config?.plugins?.whatsapp || {};

  if (!wa.enabled) {
    throw new Error("WhatsApp plugin is disabled in config.json");
  }

  const plugin = new WhatsAppPlugin(
    wa.auth_path,
    wa.default_country_code,
    wa.contacts_credentials_path,
    wa.contacts_token_path,
    {
      customQuery: async () => ""
    }
  );

  const warmIntervalMs = Number(process.env.WA_SYNC_INTERVAL_MS || 120000);
  const perChatLimit = Number(process.env.WA_SYNC_PER_CHAT_LIMIT || 40);

  console.log(`[WhatsAppSync] Starting daemon. interval=${warmIntervalMs}ms limit=${perChatLimit}`);

  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    console.log("\n[WhatsAppSync] Shutting down...");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stopped) {
    try {
      const result = await plugin.warmMessageCache(perChatLimit);
      if (result.ok) {
        console.log(
          `[WhatsAppSync] Warmed cache: loaded=${result.loaded}, chats=${result.chats}, chatsWithMessages=${result.chatsWithMessages}`
        );
        if (result.loaded === 0 && result.diagnostics) {
          console.log(
            `[WhatsAppSync] Diagnostics: loadMessages=${result.diagnostics.hasLoadMessages}, fetchMessageHistory=${result.diagnostics.hasFetchMessageHistory}, socketStoreChats=${result.diagnostics.storeChatsWithMessages}`
          );
        }
      } else {
        console.log(`[WhatsAppSync] Not ready: ${result.message}`);
      }
    } catch (err) {
      console.log(`[WhatsAppSync] Error: ${String(err?.message || err)}`);
    }

    await sleep(warmIntervalMs);
  }
}

start().catch(err => {
  console.error("[WhatsAppSync] Failed to start:", err.message);
  process.exit(1);
});
