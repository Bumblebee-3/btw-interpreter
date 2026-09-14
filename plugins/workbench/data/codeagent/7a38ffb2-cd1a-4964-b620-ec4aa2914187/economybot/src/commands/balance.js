const { QuickDB } = require('quick.db'); // QuickDB for simple key/value storage
const db = new QuickDB(); // Initialize the database instance

module.exports = {
  // Command name as it will be used in Discord (e.g., /balance)
  name: 'balance',
  // Short description for the command registry
  description: 'Displays your current balance.',
  // Whether this command can only be used in guilds
  guildOnly: true,

  /**
   * Executes the /balance command.
   * @param {Object} interaction - The Discord Interaction object (Slash Command).
   */
  async execute(interaction) {
    try {
      // Defer the reply if you anticipate any delay (optional)
      // await interaction.deferReply();

      // Retrieve the user's ID from the interaction
      const userId = interaction.user.id;

      // Construct the key used to store the balance.
      // Adjust the key pattern if your project uses a different one.
      const balanceKey = `balance_${userId}`;

      // Get the stored balance; default to 0 if none exists.
      const balance = (await db.get(balanceKey)) ?? 0;

      // Respond to the user with their balance.
      await interaction.reply({
        content: `💰 **${interaction.user.username}**, your current balance is **${balance}** coins.`,
        // Make the reply visible only to the user (ephemeral) if desired:
        // ephemeral: true
      });
    } catch (error) {
      console.error('Error executing /balance command:', error);
      // Send a generic error message to the user.
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: '❌ An error occurred while fetching your balance. Please try again later.',
          // ephemeral: true
        });
      } else {
        await interaction.reply({
          content: '❌ An error occurred while fetching your balance. Please try again later.',
          // ephemeral: true
        });
      }
    }
  },
};