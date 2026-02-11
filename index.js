const {Interpreter} = require("./src/index.js")
const dotenv = require("dotenv");
dotenv.config();
var config = require("./config.json");

var intr = new Interpreter({ groq_api_key:(config.groq_api_key || process.env.gapi) });

config.plugins.tavily.tavily_api_key = (config.plugins.tavily.tavily_api_key==""||!config.plugins.tavily.tavily_api_key)?process.env.tapi:config.plugins.tavily.tavily_api_key;
config.plugins.weather.weather_api_key = (config.plugins.weather.weather_api_key==""||!config.plugins.weather.weather_api_key)?process.env.wapi:config.plugins.weather.weather_api_key;
/*IM STOOPID*/


intr.loadCommands("./commands.json");
intr.loadPlugins("weather",config.plugins.weather);
intr.loadPlugins("calendar",config.plugins.calendar);
intr.loadPlugins("gmail",config.plugins.gmail);
intr.loadPlugins("tavily",config.plugins.tavily);
intr.loadDB(config.rag.gemini_api_key||process.env.GEMINI_API_KEY)
//order matters here btw. cuz for matching scores, first plugin will be considered.

async function a(){
    let db = intr.db;
    console.log(await intr.query("whos birthday is in august from my calendar??"));
}
a();