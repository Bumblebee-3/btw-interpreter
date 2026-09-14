require('dotenv').config(); // Load environment variables from .env

const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits, Events } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID; // Bot application ID
const GUILD_ID = process.env.DISCORD_GUILD_ID;   // Optional: register guild‑specific commands

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment.');
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Create Discord client
// -----------------------------------------------------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds], // Only need guilds intent for slash commands
});

// Store commands in a Collection for easy lookup
client.commands = new Collection();

// -----------------------------------------------------------------------------
// Load command files
// -----------------------------------------------------------------------------
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  // Each command file should export an object with:
  //   data: SlashCommandBuilder instance (or JSON representation)
  //   execute(interaction): function
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
  } else {
    console.warn(`⚠️ Command at ${filePath} is missing "data" or "execute".`);
  }
}

// -----------------------------------------------------------------------------
// Register slash commands with Discord API
// -----------------------------------------------------------------------------
const rest = new REST({ version: '10' }).setToken(TOKEN);

// Convert command data to JSON for registration
const commandsJSON = client.commands.map(cmd => cmd.data.toJSON());

(async () => {
  try {
    console.log('🔄 Started refreshing application (/) commands.');

    if (GUILD_ID) {
      // Guild‑specific registration (instant updates)
      await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        { body: commandsJSON },
      );
      console.log(`✅ Successfully reloaded ${commandsJSON.length} guild commands.`);
    } else {
      // Global registration (may take up to an hour to propagate)
      await rest.put(
        Routes.applicationCommands(CLIENT_ID),
        { body: commandsJSON },
      );
      console.log(`✅ Successfully reloaded ${commandsJSON.length} global commands.`);
    }
  } catch (error) {
    console.error('❌ Error while registering commands:', error);
  }
})();

// -----------------------------------------------------------------------------
// Event: Ready
// -----------------------------------------------------------------------------
client.once(Events.ClientReady, () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

// -----------------------------------------------------------------------------
// Event: InteractionCreate (handle slash commands)
// -----------------------------------------------------------------------------
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return; // Only handle slash commands

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    console.error(`⚠️ No command matching ${interaction.commandName} was found.`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`❌ Error executing ${interaction.commandName}:`, error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
    } else {
      await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
    }
  }
});

// -----------------------------------------------------------------------------
// Log in to Discord
// -----------------------------------------------------------------------------
client.login(TOKEN).catch(err => {
  console.error('❌ Failed to login:', err);
  process.exit(1);
});