// src/commands/deposit.js
// ---------------------------------------------------------------
// Implements the `/deposit <amount>` slash command.
// Moves money from a user's cash balance to their bank balance
// in the persistent database.
//
// Expected DB interface (../db):
//   - getUserData(userId) => Promise<{ cash: number, bank: number }>
//   - updateUserData(userId, data) => Promise<void>
//
// The command supports a numeric amount or the keyword "all".
// All replies are sent as ephemeral messages to keep balances private.
// ---------------------------------------------------------------

const { SlashCommandBuilder } = require('@discordjs/builders');
const db = require('../db'); // Adjust path if your DB module lives elsewhere

module.exports = {
  // Define the slash command schema
  data: new SlashCommandBuilder()
    .setName('deposit')
    .setDescription('Deposit money from your cash into your bank')
    .addStringOption(option =>
      option
        .setName('amount')
        .setDescription('Amount to deposit (or "all")')
        .setRequired(true)
    ),

  /**
   * Executes the deposit command.
   * @param {import('discord.js').CommandInteraction} interaction
   */
  async execute(interaction) {
    // Defer the reply to give us time for DB calls.
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const amountInput = interaction.options.getString('amount');

    // -----------------------------------------------------------------
    // 1️⃣ Retrieve the user's current financial data from the DB.
    // -----------------------------------------------------------------
    let userData;
    try {
      userData = await db.getUserData(userId);
    } catch (err) {
      console.error('[deposit] DB fetch error:', err);
      return interaction.editReply('❌ Could not retrieve your data. Please try again later.');
    }

    // If the user does not exist yet, initialise a fresh record.
    if (!userData) {
      userData = { cash: 0, bank: 0 };
    }

    // -----------------------------------------------------------------
    // 2️⃣ Parse and validate the amount the user wants to deposit.
    // -----------------------------------------------------------------
    let depositAmount;

    // Support the special keyword "all" (case‑insensitive).
    if (amountInput.trim().toLowerCase() === 'all') {
      depositAmount = userData.cash;
    } else {
      // Strip common formatting characters (commas, currency symbols, etc.).
      const sanitized = amountInput.replace(/[,₹$€£]/g, '');
      depositAmount = Number(sanitized);
    }

    // Ensure we have a positive number.
    if (isNaN(depositAmount) || depositAmount <= 0) {
      return interaction.editReply('❌ Please specify a valid positive amount to deposit.');
    }

    // User must have enough cash to cover the deposit.
    if (depositAmount > userData.cash) {
      return interaction.editReply(
        `❌ You don't have enough cash. You currently have **${userData.cash}** cash.`
      );
    }

    // -----------------------------------------------------------------
    // 3️⃣ Perform the transfer: cash -> bank.
    // -----------------------------------------------------------------
    const newCash = userData.cash - depositAmount;
    const newBank = userData.bank + depositAmount;

    try {
      await db.updateUserData(userId, { cash: newCash, bank: newBank });
    } catch (err) {
      console.error('[deposit] DB update error:', err);
      return interaction.editReply('❌ Failed to update your balance. Please try again later.');
    }

    // -----------------------------------------------------------------
    // 4️⃣ Send a success message.
    // -----------------------------------------------------------------
    return interaction.editReply(
      `✅ Successfully deposited **${depositAmount}** coins.\n` +
      `Cash: **${newCash}** | Bank: **${newBank}**`
    );
  },
};