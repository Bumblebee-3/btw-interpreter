# BTW - Interpreter
## A backend for BTW (Bumblebee Trusts Wikipedia - voice assistant for Arch Linux). Based on Groqs chat completion endpoints.

## Features
- System commands: run system commands like setting screen brightness, locking, shutting down, setting volume, updating packages etc.
- Plugins: supports community made plugins to give GROQ as much information as needed (from gmail/calendar/weather api/web search via tavily etc.) to answer your questions accurately.
- RAG: inbuilt RAG capabilities using LanceDB and Gemini embedding models.

## Things you can ask it to do (as of now)
```
What was the latest email (person x) sent me?
Can you set my screen brightness to 30%?
lock my laptop.
What events do I have in my calendar in august?
What is the weather today?
What is the stock price of NVIDIA?
What were Lewis Hamilton's thoughts on the new 2026 regulations?
```

## Instructions to use

```javascript
const {Interpreter} = require("./src/index.js")

var interpreter = new Interpreter({ groq_api_key:"API KEY HERE" });//get one at console.groq.com
```
### 1. Normal GROQ AI chatbot:
```javascript
console.log(await interpreter.query("What is the integral of 2x^2 ?"));
```
### 2. Giving it access to System Commands
```javascript
interpreter.loadCommands("./path/to/commands/json/file");
```
now, this will work:
```js
console.log(await interpreter.query("please update my system packages."));
```

How to write your own `commands.json` file:
```json
{
    "id": "id_of_command",//can be anything
    "category": "category",//category of command (brightness/volume/etc)
    "description": "description of the command",//eg. Set screen brightness to a given percentage
    "examples": [
      "set brightness to {value} percent",
      "set screen brightness to {value}",
      "set brightness at {value}%",
      "brightness to {value}"
    ],//{value} will be auto parsed (it is a parameter.)
    "dangerous": false,//if dangerous command, it will show confirmation dialog before running.
    "details":{//only required if dangerous command
      "title":"Bumblebee",//title of popup 
      "description":"Are you sure you want to shut down?"//description of popup
    },
    "parameters": {"value": "int 0-100"},//allowed values of input
    "shell_command_template": "brightnessctl set {value}%"//will run this command in the terminal.
}
```

#### Please note: dangerous commands use zenity to show confirmation dialogs. if you want to use something else, you can edit `/src/scripts/notify.sh`

#### ⚠️ WARNING: System commands execute directly in the shell. Only load trusted command files and plugins.

### 3. Loading Plugins
List of inbuilt plugins
- `calendar` (uses google calendar. You will require a `credentials.json` file (google cloud console) and `token.json` file. Token.json can be generated via generate_token.js script.You will also need to install googleapis : `npm i googleapis`)
- `gmail` (uses Gmail. Same requirements as calendar)
- `tavily` (Gives the user Web Scraping features for live data, news etc. You will need an API key though.)
- `weather` (Weather updates. Requires an API key )

The data passed from plugins is automatically given to GROQ as a system prompt.

#### Interested in building your own plugin? Read [plugins.md](./plugins.md).

### 4. Enabling and using RAG

```shell
npm install @google/generative-ai
npm install @lancedb/lancedb
```

```javascript
interpreter.loadDB("GEMINI_API_KEY");//required for creating embeddings!
let db = interpreter.db;
```
### Create a table
```js
await db.createTable("memory");
await db.createTable("birthdays");
```
### Add data to table.
```js
  await db.addToTable("memory", "User likes Arch Linux.");
  await db.addToTable("memory", "User's system specifications are:Dell Inspiron 15 3567 which has cpu: core i3 6006u,gpu: Intel hd 520 graphics and ram: 16 gb ddr4.");
  await db.addToTable("birthdays", "A's birthday is on 12th August.");
  await db.addToTable("birthdays", "B's birthday is on 28th March.");
```
### Query a specific table
```js
  const results = await db.queryTable("birthdays", "Whose birthday is in august?");
  console.log(results);
```
### This data can also be retrieved using 
```js
console.log(await interpreter.query("What is the integral of 2x^2 ?"));
```
### Delete a table
```js
await db.deleteTable("birthdays");
```



### Note: All api keys required for this project have a free tier and in most cases (except probably, tavily) you will not exceed the quota.