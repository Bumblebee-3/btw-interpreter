const dotenv = require("dotenv");
dotenv.config();

// interactive.js
const path = require("path");
const { Interpreter } = require("./src/index.js");
const config = require("./config.json");

const intr = new Interpreter({ lm_studio: config.lm_studio });

// attach interpreter to plugin params so plugins can call back to LLM
config.plugins.gmail.obj = intr;
config.plugins.calendar.obj = intr;
if (config.plugins.whatsapp) config.plugins.whatsapp.obj = intr;
config.plugins.tavily.tavily_api_key = (config.plugins.tavily.tavily_api_key==""||!config.plugins.tavily.tavily_api_key)?process.env.tapi:config.plugins.tavily.tavily_api_key;

if (config.plugins.reminder && config.plugins.reminder.enabled === true) {
  intr.initReminderSystem({
    storagePath: config.plugins.reminder.storage_path,
    notifyScriptPath: path.resolve(__dirname, "src/scripts/reminder_notify.sh"),
    pollIntervalMs: config.plugins.reminder.poll_interval_ms
  });
  config.plugins.reminder.reminder_manager = intr.reminderManager;
}


// load features (order similar to index.js)
intr.loadCommands(path.resolve(__dirname,"commands.json"));
intr.loadPlugins("weather", config.plugins.weather);
intr.loadPlugins("calendar", config.plugins.calendar);
intr.loadPlugins("gmail", config.plugins.gmail, process.env.email);
intr.loadPlugins("tavily", config.plugins.tavily);
if (config.plugins.whatsapp && config.plugins.whatsapp.enabled === true) {
  intr.loadPlugins("whatsapp", config.plugins.whatsapp);
}
if (config.plugins.reminder && config.plugins.reminder.enabled === true) {
  intr.loadPlugins("reminder", config.plugins.reminder);
}
intr.loadDB(config.rag.location, config.rag.table_limit);
if (config.plugins.browser && config.plugins.browser.enabled === true) {
  intr.loadPlugins("browser",config.plugins.browser);
}
async function a(){
await intr.db.addToTable("memory", "User likes Arch Linux.");
await intr.db.addToTable("memory", "User's system specifications are:Dell Inspiron 15 3567 which has cpu: core i3 6006u,gpu: Intel hd 520 graphics and ram: 16 gb ddr4.");
}
//a();
const readline = require("readline").createInterface({ input: process.stdin, output: process.stdout });
let isClosed = false;

readline.on("close", () => {
  isClosed = true;
});

async function loop() {
  if (isClosed) return;

  readline.question("You: ", async (q) => {
    if (isClosed) return;

    try {
      const res = await intr.query(q);
      console.log("Assistant:", res);
    } catch (err) {
      console.error("Error:", err.message);
    }

    if (isClosed) return;
    loop();
  });
}

loop();