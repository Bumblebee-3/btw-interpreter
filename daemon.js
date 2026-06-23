const http = require("http");
const path = require("path");
const { Interpreter } = require("./src/index.js");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, ".env") });

function createInterpreter() {
  const config = JSON.parse(JSON.stringify(require(path.resolve(__dirname, "config.json"))));
  const intr = new Interpreter({ groq_api_key: (config.groq_api_key || process.env.gapi) });

  config.plugins.tavily.tavily_api_key = (config.plugins.tavily.tavily_api_key == "" || !config.plugins.tavily.tavily_api_key) ? process.env.tapi : config.plugins.tavily.tavily_api_key;
  config.plugins.weather.weather_api_key = (config.plugins.weather.weather_api_key == "" || !config.plugins.weather.weather_api_key) ? process.env.wapi : config.plugins.weather.weather_api_key;
  
  config.plugins.gmail.obj = intr;
  config.plugins.calendar.obj = intr;
  if (config.plugins.whatsapp) config.plugins.whatsapp.obj = intr;
  if (config.plugins.browser) config.plugins.browser.obj = intr;
  
  if (config.plugins.reminder && config.plugins.reminder.enabled === true) {
    intr.initReminderSystem({
      storagePath: config.plugins.reminder.storage_path,
      notifyScriptPath: path.resolve(__dirname, "src/scripts/reminder_notify.sh"),
      pollIntervalMs: config.plugins.reminder.poll_interval_ms
    });
    config.plugins.reminder.reminder_manager = intr.reminderManager;
  }
  
  intr.loadCommands(__dirname + "/commands.json");
  intr.loadPlugins("weather", config.plugins.weather);
  intr.loadPlugins("calendar", config.plugins.calendar);
  intr.loadPlugins("gmail", config.plugins.gmail, process.env.email);
  intr.loadPlugins("tavily", config.plugins.tavily);
  
  if (config.plugins.whatsapp && config.plugins.whatsapp.enabled === true) {
    intr.loadPlugins("whatsapp", config.plugins.whatsapp);
  }
  if (config.plugins.browser && config.plugins.browser.enabled === true) {
    intr.loadPlugins("browser", config.plugins.browser);
  }
  if (config.plugins.reminder && config.plugins.reminder.enabled === true) {
    intr.loadPlugins("reminder", config.plugins.reminder);
  }
  
  intr.loadDB(config.rag.location, config.rag.table_limit);
  intr.email = process.env.email;
  // Initialize db table early
  intr.db.createTable("gmail_rag").catch(console.error);

  return intr;
}

const sessions = new Map();

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") return res.end();
  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    try {
      const { text, session_id } = JSON.parse(body);
      if (!sessions.has(session_id)) {
        sessions.set(session_id, createInterpreter());
      }
      const intr = sessions.get(session_id);
      
      const result = await intr.query(text);
      
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error(e);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(52525, "127.0.0.1", () => {
  console.log("Interpreter daemon listening on http://127.0.0.1:52525");
});
