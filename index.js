const originalLog = console.log;
if (process.argv.length > 2) {
  console.log = function () {}; // silence everything
}

module.exports = {originalLog};
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
config.plugins.gmail.obj = intr;
intr.loadCommands(__dirname+"/commands.json");
intr.loadPlugins("weather",config.plugins.weather);
intr.loadPlugins("calendar",config.plugins.calendar);
intr.loadPlugins("gmail",config.plugins.gmail,process.env.email);
intr.loadPlugins("tavily",config.plugins.tavily);
intr.loadDB(config.rag.location,config.rag.table_limit);


//order matters here btw. cuz for matching scores, first plugin will be considered.


async function main() {
  await intr.db.createTable("gmail_rag");
  const question = process.argv.slice(2).join(" ");
  intr.email=process.env.email;

  if (!question) {
    originalLog("Usage: node index.js \"your question here\"");
    process.exit(1);
  }
  //originalLog(await intr.db.queryTable("gmail_rag","manish savant",100))

  try {
    const response = await intr.query(question);
    originalLog(response);
  } catch (err) {
    originalLog("Error: "+err.message);
  }
}

main();
