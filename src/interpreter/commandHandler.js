const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { spawn } = require("node:child_process");
const execFileAsync = promisify(execFile);


function toRegex(inp) {//need to find a better way to do ts 
  let pattern = inp.toLowerCase();
  pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  pattern = pattern
    .replace(/\\\{value\\\}/g, "(\\d+)")
    .replace(/\\\{delta\\\}/g, "(\\d+)");
  return new RegExp(pattern, "i");
}

function tokenScore(example, input) {
  const ext = example.toLowerCase().replace(/\{.*?\}/g, "").split(/\s+/).filter(Boolean);
  const int = input.toLowerCase().replace(/\{.*?\}/g, "").split(/\s+/).filter(Boolean);
  let hits = 0;
  for (const tok of ext) {if (int.includes(tok)) hits++;}
  return hits / ext.length;
}

function intentScore(example, match, text) {
  let score = 0;
  score += match[0].length / text.length;
  score += tokenScore(example, text);
  if (example.includes("{value}") || example.includes("{delta}")) score += 0.2;
  return Math.min(score, 1);
}
/*Dont question this logic lmao*/
function checkCommands(input, obj) {
  if(!obj.command.location ){
    return {
      isCommand: false,
      cmd: null
    };
  }
  const commands = require(obj.command.location);
  const text = input.toLowerCase().replace(/[%]/g, " percent").replace(/\s+/g, " ").trim();

  let bestMatch = null;
  let bestScore = 0;

  for (const cmd of commands) {
    for (const example of cmd.examples) {
      const regex = toRegex(example);
      const match = text.match(regex);
      if (!match) continue;

      const score = intentScore(example, match, text);
      if (score > bestScore) {
        bestScore = score;
        const params = {};
        if (example.includes("{value}")) params.value = Number(match[1]);
        if (example.includes("{delta}")) params.delta = Number(match[1]);

        bestMatch = {
          id: cmd.id,
          command: cmd,
          parameters: params,
          confidence: score
        };
      }
    }
  }

  if (!bestMatch || bestScore < 0.6) {
    return {
      isCommand: false,
      cmd: null
    };
  }

  return {
    isCommand: true,
    cmd: bestMatch
  };
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

async function handleCommand(cmd) {
  if (cmd.command.dangerous === true) {
    const approved = await confirm(cmd.command.details.title,cmd.command.details.description);
    if (!approved) {
      return ("User denied running command.");
    }
  }

  try {
    let command = resolveCommand(cmd.command.shell_command_template , cmd.parameters);
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