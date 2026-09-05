//REQUIRES AI LAYER!
const { callLLMSmall, extractContent } = require("./llm.js");
//need to find a better way to do ts 

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { spawn } = require("node:child_process");
const execFileAsync = promisify(execFile);



function tokenScore(example, input) {
  const ext = example.toLowerCase().replace(/\{.*?\}/g, "").split(/\s+/).filter(Boolean);
  const int = input.toLowerCase().replace(/\{.*?\}/g, "").split(/\s+/).filter(Boolean);
  let hits = 0;
  for (const tok of ext) {if (int.includes(tok)) hits++;}
  return hits / ext.length;
}


/*Dont question this logic lmao*/
async function checkCommands(input, obj) {
  if(!obj.command.location ){
    return {
      isCommand: false,
      cmd: null
    };
  }
  const commands = require(obj.command.location);

  var prompt = "You are a helpful voice assistant named Bumblebee. You are given a list of commands with their details and examples. Your task is to identify if the user's input matches any of the commands based on the examples provided. If a match is found, return the command ID and any parameters extracted from the input. If no match is found, return null.\n\nCommands:\n";
  for (const cmd of commands) {
    prompt += `Command ID: ${cmd.id}\nDescription: ${cmd.description}\nExamples:\n`;
    for (const example of cmd.examples) {
      prompt += `- ${example}\n`;
    }
    prompt += "\n";
  }
  prompt += `User Input: "${input}"\n\nIdentify the best matching command and extract parameters if applicable. If no match is found, return null.if match is found output must be json of the format: {"command_id": "matched_command_id", "value": "extracted_value"} or if no match is found output must be "null". PLEASE NOTE: You have to contexxt aware, only if the user intends to execute an action only then must you return that command. If the user is asking for information or help, you must return "null".`;
  try {
    var ans = await callLLMSmall(prompt, obj.llm_config);
    const content = extractContent(ans, obj.llm_config.provider);
    if (content === "null") {
      return { isCommand: false, cmd: null };
    }

    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { isCommand: false, cmd: null };

    const parsed = JSON.parse(match[0]);
    const matched = commands.find(c => c.id === parsed.command_id);
    if (!matched) return { isCommand: false, cmd: null };

    return {
      isCommand: true,
      cmd: matched,
      params: parsed.value
    };
  } catch (error) {
    console.warn("[commandRouter] LLM command routing failed:", error.message);
    return { isCommand: false, cmd: null };
  }
}


async function confirm(title, body) {
  try {
    const path = __dirname.replace("/src/interpreter","/src")+"/scripts/notify.sh";
    await execFileAsync(
      path,
      [title, body],
      { timeout: 60000 }
    );
    return true;
  } catch (err) {
    return false;
  }
}


function runShellCommand(command) {
  const child = spawn(command, {
    shell: true,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}


/*
{
  isCommand: true,
  cmd: {
    id: 'system_shutdown',
    command: {
      id: 'system_shutdown',
      category: 'power',
      description: 'Shut down the system',
      examples: [Array],
      dangerous: true,
      details: [Object],
      parameters: {},
      shell_command_template: 'systemctl poweroff'
    },
    parameters: {},
    confidence: 1
  }
}*/

function resolveCommand(template, parameters) {
  let cmd = template;

  for (const [key, value] of Object.entries(parameters)) {
    cmd = cmd.replaceAll(`{${key}}`, String(value));
  }

  return cmd;
}

async function handleCommand(cmd,params) {
  cmd.command = cmd;
  console.log(cmd,params);
  if (cmd.command.dangerous === true) {
    const approved = await confirm(cmd.command.details.title,cmd.command.details.description);
    if (!approved) {
      return ("User denied running command.");
    }
  }

  try {
    let command = resolveCommand(cmd.command.shell_command_template , {value:params});
    //console.log(params);
    await runShellCommand(command);
    return ("Command executed successfully.");
  } catch (err) {
    console.error("Command failed:", err.message);
    return "Error occurred!";
  }
}


module.exports = {
  checkCommands,
  handleCommand
}