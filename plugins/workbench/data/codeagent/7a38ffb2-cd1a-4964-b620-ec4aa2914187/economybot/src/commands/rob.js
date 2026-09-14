const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');

// Path to a simple JSON file that stores user balances.
// In a real project this would be replaced by a proper database or a dedicated balance utility.
const BALANCES_FILE = path.resolve(__dirname, '../../data/balances.json');

/**
 * Loads the balances JSON, creating the file if it doesn't exist.
 * @returns {Object} Mapping of userId => balance (number)
 */
function loadBalances() {
    try {
        if (!fs.existsSync(BALANCES_FILE)) {
            fs.mkdirSync(path.dirname(BALANCES_FILE), { recursive: true });
            fs.writeFileSync(BALANCES_FILE, JSON.stringify({}));
        }
        const raw = fs.readFileSync(BALANCES_FILE);
        return JSON.parse(raw);
    } catch (err) {
        console.error('Failed to load balances:', err);
        return {};
    }
}

/**
 * Persists the balances mapping to disk.
 * @param {Object} balances
 */
function saveBalances(balances) {
    try {
        fs.writeFileSync(BALANCES_FILE, JSON.stringify(balances, null, 2));
    } catch (err) {
        console.error('Failed to save balances:', err);
    }
}

/**
 * Retrieves a user's current balance, defaulting to 0.
 * @param {string} userId
 * @returns {number}
 */
function getBalance(userId) {
    const balances = loadBalances();
    return balances[userId] ?? 0;
}

/**
 * Adjusts a user's balance by the given amount (positive or negative).
 * @param {string} userId
 * @param {number} amount
 */
function addBalance(userId, amount) {
    const balances = loadBalances();
    const current = balances[userId] ?? 0;
    balances[userId] = Math.max(current + amount, 0); // never go negative
    saveBalances(balances);
}

/**
 * Returns a random integer between min (inclusive) and max (inclusive).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Core rob logic.
 * @param {object} robber - Discord User object of the person attempting the robbery.
 * @param {object} victim - Discord User object of the target.
 * @returns {object} Result object containing success flag, amount, and message.
 */
function attemptRob(robber, victim) {
    const SUCCESS_CHANCE = 0.30; // 30% chance to succeed
    const victimBalance = getBalance(victim.id);

    // If the victim has no money, the robbery automatically fails.
    if (victimBalance < 1) {
        return {
            success: false,
            amount: 0,
            message: `${victim.username} doesn't have any cash to steal!`,
        };
    }

    // Determine if the robbery succeeds.
    const succeeded = Math.random() < SUCCESS_CHANCE;

    if (succeeded) {
        // Rob up to 50% of the victim's money, but at least 1.
        const maxSteal = Math.max(1, Math.floor(victimBalance * 0.5));
        const amount = randomInt(1, maxSteal);

        // Transfer money.
        addBalance(victim.id, -amount);
        addBalance(robber.id, amount);

        return {
            success: true,
            amount,
            message: `${robber.username} successfully robbed ${victim.username} and walked away with **${amount}** coins!`,
        };
    } else {
        // Optional penalty for failing: lose a small random amount (up to 10% of robber's balance).
        const robberBalance = getBalance(robber.id);
        const penalty = robberBalance > 0 ? randomInt(1, Math.max(1, Math.floor(robberBalance * 0.1))) : 0;

        if (penalty > 0) {
            addBalance(robber.id, -penalty);
        }

        return {
            success: false,
            amount: -penalty,
            message: `${robber.username} tried to rob ${victim.username} but got caught! ${penalty > 0 ? `They lose **${penalty}** coins as a fine.` : ''}`,
        };
    }
}

module.exports = {
    // Slash command definition
    data: new SlashCommandBuilder()
        .setName('rob')
        .setDescription('Attempt to rob another user')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('The user you want to rob')
                .setRequired(true)
        ),

    /**
     * Executes the /rob command.
     * @param {import('discord.js').ChatInputCommandInteraction} interaction
     */
    async execute(interaction) {
        const robber = interaction.user;
        const victim = interaction.options.getUser('target');

        // Basic validation
        if (victim.id === robber.id) {
            return interaction.reply({ content: "You can't rob yourself!", ephemeral: true });
        }
        if (victim.bot) {
            return interaction.reply({ content: "You can't rob bots!", ephemeral: true });
        }

        // Perform the robbery
        const result = attemptRob(robber, victim);

        // Build a nice embed to show the outcome
        const embed = new EmbedBuilder()
            .setTitle('Robbery Attempt')
            .setDescription(result.message)
            .setColor(result.success ? 0x00ff00 : 0xff0000)
            .addFields(
                { name: 'Robber', value: `${robber.username}`, inline: true },
                { name: 'Victim', value: `${victim.username}`, inline: true },
                { name: 'Amount', value: `${result.success ? '+' : '-'}${Math.abs(result.amount)} coins`, inline: true }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    },
};