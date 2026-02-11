const {Interpreter} = require("./src/index.js")
const dotenv = require("dotenv");
dotenv.config();
var config = require("./config.json");

var intr = new Interpreter({
    groq_api_key:config.groq_api_key || process.env.gapi
});

config.plugins.tavily.tavily_api_key = (config.plugins.tavily.tavily_api_key==""||!config.plugins.tavily.tavily_api_key)?process.env.tapi:config.plugins.tavily.tavily_api_key;
config.plugins.weather.weather_api_key = (config.plugins.weather.weather_api_key==""||!config.plugins.weather.weather_api_key)?process.env.wapi:config.plugins.weather.weather_api_key;

intr.loadCommands("./commands.json")
intr.loadPlugins("tavily",config.plugins.tavily);
intr.loadPlugins("calendar",config.plugins.calendar);
intr.loadPlugins("gmail",config.plugins.gmail);
intr.loadPlugins("weather",config.plugins.weather);


async function a(){
console.log(await intr.query("what is the weather like today?"));
}
a();