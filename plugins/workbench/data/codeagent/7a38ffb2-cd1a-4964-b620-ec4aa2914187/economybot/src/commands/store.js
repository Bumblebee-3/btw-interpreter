const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// Static definition of store items
// Each item has a name, description (optional), and price in virtual currency units
const STORE_ITEMS = [
  {
    name: 'Iron Sword',
    description: 'A sturdy sword made of iron. Increases attack damage.',
    price: 150,
  },
  {
    name: 'Health Potion',
    description: 'Restores 50 HP when consumed.',
    price: 50,
  },
  {
    name: 'Magic Staff',
    description: 'A staff imbued with magical energy. Boosts spell power.',
    price: 300,
  },
  {
    name: 'Leather Armor',
    description: 'Light armor offering basic protection.',
    price: 120,
  },
  {
    name: 'Gem Pack (10 gems)',
    description: 'A pack of 10 premium gems.',
    price: 500,
  },
];

/**
 * Formats the store items into a Discord embed.
 * @returns {EmbedBuilder} An embed containing the store listing.
 */
function createStoreEmbed() {
  const embed = new EmbedBuilder()
    .setTitle('🛒 Store')
    .setDescription('Below are the items currently available for purchase. Use the appropriate command to buy an item.')
    .setColor(0x00ae86) // A pleasant teal color
    .setTimestamp();

  // Add a field for each store item
  for (const item of STORE_ITEMS) {
    // Field name shows the item and its price
    const fieldName = `**${item.name}** — ${item.price} 💰`;
    // Field value shows the description, or a placeholder if missing
    const fieldValue = item.description || '*No description available.*';
    embed.addFields({ name: fieldName, value: fieldValue });
  }

  return embed;
}

/**
 * Retrieves an item definition by its name (case‑insensitive).
 * @param {string} name The name of the item to look up.
 * @returns {object|undefined} The matching item object or undefined if not found.
 */
function getItemByName(name) {
  return STORE_ITEMS.find(
    (item) => item.name.toLowerCase() === name.toLowerCase()
  );
}

// Export the command definition for the Discord bot
module.exports = {
  // Register the /store slash command
  data: new SlashCommandBuilder()
    .setName('store')
    .setDescription('View the list of items available for purchase in the store.'),

  /**
   * Handles execution of the /store command.
   * @param {import('discord.js').ChatInputCommandInteraction} interaction The interaction object.
   */
  async execute(interaction) {
    try {
      // Create the embed with all store items
      const embed = createStoreEmbed();

      // Reply to the interaction with the embed; make it visible to everyone in the channel
      await interaction.reply({ embeds: [embed] });
    } catch (error) {
      console.error('Error executing /store command:', error);
      // Send a generic error message to the user
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: '⚠️ An error occurred while fetching the store items. Please try again later.',
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: '⚠️ An error occurred while fetching the store items. Please try again later.',
          ephemeral: true,
        });
      }
    }
  },

  // Export utility functions for potential reuse in other commands (e.g., /buy)
  STORE_ITEMS,
  getItemByName,
};