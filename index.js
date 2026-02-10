const {Interpretter} = require("./src/index.js")
const dotenv = require("dotenv");
dotenv.config();

var intr = new Interpretter({
    groq_api_key:process.env.gapi
});
intr.loadCommands("./commands.json")

intr.loadPlugins("./plugins/tavily/plugindata.json",{
    "search_depth":"basic",
    "country":"india",
    "tavily_api_key":process.env.tapi
});

intr.loadPlugins("./plugins/calendar/plugindata.json",{
    credentials_path:"./plugins/credentials.json",
    token_path:"./plugins/token.json"
});

intr.loadPlugins("./plugins/gmail/plugindata.json",{
    credentials_path:"./plugins/credentials.json",
    token_path:"./plugins/token.json"
});

intr.loadPlugins("./plugins/weather/plugindata.json",{
    weather_api_key:process.env.wapi,
    default_location:"mumbai"
});
async function a(){
console.log(await intr.query("what is the weather like today?"));
}
a();