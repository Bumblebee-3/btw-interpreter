const originalLog = console.log;
if (process.argv.length > 2) {
  console.log = function () {}; // silence everything
}
const path = require("path");
const {Interpreter} = require("./src/index.js")
const dotenv = require("dotenv");
dotenv.config({
  path: path.resolve(__dirname, ".env")
});


var config = require((path.resolve(__dirname, "config.json")))

var intr = new Interpreter({ groq_api_key:(config.groq_api_key || process.env.gapi) });

config.plugins.tavily.tavily_api_key = (config.plugins.tavily.tavily_api_key==""||!config.plugins.tavily.tavily_api_key)?process.env.tapi:config.plugins.tavily.tavily_api_key;
config.plugins.weather.weather_api_key = (config.plugins.weather.weather_api_key==""||!config.plugins.weather.weather_api_key)?process.env.wapi:config.plugins.weather.weather_api_key;
/*IM STOOPID*/


intr.loadCommands(__dirname+"/commands.json");
intr.loadPlugins("weather",config.plugins.weather);
intr.loadPlugins("calendar",config.plugins.calendar);
intr.loadPlugins("gmail",config.plugins.gmail);
intr.loadPlugins("tavily",config.plugins.tavily);
intr.loadDB(config.rag.gemini_api_key||process.env.GEMINI_API_KEY,"/home/bumblebee/Desktop/btw-voiceassistant/interpreter/lancedb/",{
  "birthdays":1,
  "documents":5,
  "memory":5
})
//order matters here btw. cuz for matching scores, first plugin will be considered.


async function main() {
  const question = process.argv.slice(2).join(" ");

  if (!question) {
    originalLog("Usage: node index.js \"your question here\"");
    process.exit(1);
  }

  try {
    const response = await intr.query(question);
    originalLog(response);
  } catch (err) {
    originalLog("Error: "+err.message);
  }
}

main();
