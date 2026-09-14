const { SlashCommandBuilder } = require('@discordjs/builders');
const store = require('../data/store'); // { itemName: { price: Number, description: String, ... } }
const User = require('../models/User'); // Mongoose model or similar user data handler

module.exports = {
  // Define the /buy command with a required "item" string option
  data: new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Purchase an item from the store')
    .addStringOption(option =>
      option
        .setName('item')
        .setDescription('Name of the item you want to buy')
        .setRequired(true)
    ),

  /**
   * Executes the buy command.
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    // Get the item name from the command options and normalize it
    const rawItemName = interaction.options.getString('item');
    const itemName = rawItemName.trim().toLowerCase();

    // Look up the item in the store definition
    const item = store[itemName];
    if (!item) {
      // Item does not exist – inform the user
      return interaction.reply({
        content: `❌ The item **${rawItemName}** does not exist in the store.`,
        ephemeral: true,
      });
    }

    // Retrieve (or create) the user's data record
    let user = await User.findOne({ userId: interaction.user.id });
    if (!user) {
      // If the user has never been seen before, start them with 0 cash and an empty inventory
      user = new User({
        userId: interaction.user.id,
        cash: 0,
        inventory: {},
      });
    }

    // Ensure the user has enough cash to purchase the item
    if (user.cash < item.price) {
      return interaction.reply({
        content: `❌ You need **${item.price}** coins to buy **${rawItemName}**, but you only have **${user.cash}** coins.`,
        ephemeral: true,
      });
    }

    // Deduct the price from the user's cash balance
    user.cash -= item.price;

    // Add the purchased item to the user's inventory (increment count)
    user.inventory[itemName] = (user.inventory[itemName] || 0) + 1;

    // Persist the changes to the database
    await user.save();

    // Confirm the purchase to the user
    return interaction.reply({
      content: `✅ You have purchased **${rawItemName}** for **${item.price}** coins!`,
      ephemeral: false,
    });
  },
};