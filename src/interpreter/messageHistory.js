class MessageHistory {
    constructor(maxTurns = 10) {
        this.maxTurns = maxTurns;
        this.history = [];
    }

    // Truncate data to specified character limits
    truncateData(data, maxLength) {
        if (typeof data === 'string') {
            return data.substring(0, maxLength);
        } else {
            const jsonStr = JSON.stringify(data);
            return jsonStr.substring(0, maxLength);
        }
    }

    // Add a turn to history
    addTurn(turn) {
        this.history.push(turn);
        
        // Keep only the last N turns
        if (this.history.length > this.maxTurns) {
            this.history.shift();
        }
    }

    // Get formatted history context for LLM prompts
    getHistoryContext() {
        if (this.history.length === 0) {
            return '';
        }

        let context = '[Conversation history]\n';
        
        for (const turn of this.history) {
            context += `User (${turn.timestamp}): ${turn.userQuery}\n`;
            
            if (turn.toolName) {
                context += `Tool: ${turn.toolName}\n`;
            }
            
            if (turn.rawToolData !== null && turn.rawToolData !== undefined) {
                const truncatedData = this.truncateData(turn.rawToolData, 1200);
                context += `Raw data: ${truncatedData}\n`;
            }
            
            if (turn.llmFormattedResult) {
                const truncatedResult = this.truncateData(turn.llmFormattedResult, 400);
                context += `Response: ${truncatedResult}\n`;
            }
        }
        
        context += '[End of history]\n';
        return context;
    }

    // Clear history
    clear() {
        this.history = [];
    }

    // Get current history length
    getLength() {
        return this.history.length;
    }

    // Get full history (for debugging or serialization)
    getAll() {
        return [...this.history];
    }
}

module.exports = MessageHistory;