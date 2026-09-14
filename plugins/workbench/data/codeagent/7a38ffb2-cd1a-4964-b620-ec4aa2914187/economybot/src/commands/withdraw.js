const path = require('path');
const fs = require('fs');

// Simple JSON‑based persistence (fallback if a proper economy module doesn't exist)
const dataFile = path.resolve(__dirname, '../../data/economy.json');

// Helper to load the whole DB
function loadDB() {
    try {
        return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    } catch (e) {
        // If the file doesn't exist or is malformed start with an empty DB
        return {};
    }
}

// Helper to save the whole DB
function saveDB(db) {
    fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf8');
}

// Retrieve a user record, creating a default one if needed
function getUser(id) {
    const db = loadDB();
    if (!db[id]) {
        db[id] = { cash: 0, bank: 0 };
        saveDB(db);
    }
    return db[id];
}

// Persist changes for a user
function setUser(id, data) {
    const db = loadDB();
    db[id] = data;
    saveDB(db);
}

/**
 * /withdraw <amount>
 * Moves money from the user's bank balance to their cash balance.
 * Supports the keyword "all" to withdraw the entire bank amount.
 */
module.exports = {
    name: 'withdraw',
    description: 'Withdraw money from your bank account to cash.',
    usage: '<amount|all>',
    /**
     * @param {Object} message - Discord.js Message object
     * @param {Array<string>} args - Command arguments
     */
    async execute(message, args) {
        // Ensure an amount was provided
        if (!args.length) {
            return message.channel.send(
                `❌ You need to specify an amount to withdraw.\nUsage: \`/withdraw ${this.usage}\``
            );
        }

        const userId = message.author.id;
        const user = getUser(userId);

        // Determine the amount to withdraw
        let withdrawAmount;
        const rawAmount = args[0].toLowerCase();

        if (rawAmount === 'all') {
            withdrawAmount = user.bank;
        } else {
            // Parse as integer; allow commas or spaces (e.g., "1,000")
            const sanitized = rawAmount.replace(/[, ]/g, '');
            withdrawAmount = parseInt(sanitized, 10);
        }

        // Validate the parsed amount
        if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
            return message.channel.send('❌ Please provide a valid positive number to withdraw.');
        }

        // Check if the user has enough money in the bank
        if (withdrawAmount > user.bank) {
            return message.channel.send(
                `❌ You don't have that much money in the bank. Your bank balance is **${user.bank}**.`
            );
        }

        // Perform the transaction
        const newBankBalance = user.bank - withdrawAmount;
        const newCashBalance = user.cash + withdrawAmount;

        // Persist the updated balances
        setUser(userId, {
            cash: newCashBalance,
            bank: newBankBalance,
        });

        // Send a confirmation message
        return message.channel.send(
            `✅ You successfully withdrew **${withdrawAmount}** coins.\n` +
            `💰 Cash: **${newCashBalance}** | 🏦 Bank: **${newBankBalance}**`
        );
    },
};