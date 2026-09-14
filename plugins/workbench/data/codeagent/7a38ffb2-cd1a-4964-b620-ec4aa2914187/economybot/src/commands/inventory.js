const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');

// In‑memory storage for user inventories.
// Key: Discord user ID (string)
// Value: Array of item names (strings)
const inventories = new Map();

/**
 * Retrieve a user's inventory.
 * @param {string} userId - The Discord user ID.
 * @returns {string[]} Array of item names (empty if none).
 */
function getUserInventory(userId) {
  return inventories.get(userId) || [];
}

/**
 * Add a single item to a user's inventory.
 * Exported for use by other parts of the bot (e.g., loot commands).
 * @param {string} userId - The Discord user ID.
 * @param {string} item - The name of the item to add.
 */
function addItem(userId, item) {
  const current = inventories.get(userId) || [];
  current.push(item);
  inventories.set(userId, current);
}

/**
 * Replace a user's entire inventory (useful for testing or admin actions).
 * @param {string} userId - The Discord user ID.
 * @param {string[]} items - Array of item names.
 */
function setInventory(userId, items) {
  inventories.set(userId, items);
}

/**
 * Exported command definition for the `/inventory` slash command.
 */
module.exports = {
  // Command registration data for Discord.
  data: new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('Show the items you currently own.'),

  /**
   * Execute the command – sends an embed with the user's items or a notice if empty.
   * @param {import('discord.js').CommandInteraction} interaction
   */
  async execute(interaction) {
    // Defer the reply in case fetching/processing takes time.
    await interaction.deferReply();

    const userId = interaction.user.id;
    const items = getUserInventory(userId);

    if (items.length === 0) {
      // No items – simple text response.
      await interaction.editReply('You have no items in your inventory.');
    } else {
      // Build an embed listing each item.
      const embed = new MessageEmbed()
        .setTitle(`${interaction.user.username}'s Inventory`)
        .setDescription(
          items
            .map((item, index) => `**${index + 1}.** ${item}`)
            .join('\n')
        )
        .setColor('#00FF00') // Green for visibility.
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }
  },

  // Helper functions exported for other modules (e.g., loot, shop) to manipulate inventories.
  addItem,
  setInventory,
  getUserInventory,
};