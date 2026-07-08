const FOLLOW_UP_PRONOUNS = /\b(it|that|this|they|them|its|those|these)\b/i;
const FOLLOW_UP_RELATIVE = /\b(also|too|as well|instead|rather|versus|compared to)\b/i;
const FOLLOW_UP_IMPLICIT = /\b(will it work|is it good|what about|how about|and the|what does it)\b/i;
const META_INSTRUCTION = /\b(research|find out|look it up|look up|tell me more|dig deeper|learn more|investigate|check)\b/i;
const COMMAND_VERBS = /^(turn|lock|unlock|open|close|start|stop|enable|disable|mute|unmute|increase|decrease|play|pause|resume|launch|restart|shutdown|power off|poweroff|reboot|next|previous|skip|scroll|zoom|screenshot|take screenshot|go back|go forward)\b/i;
const MAX_REWRITE_LENGTH = 120;

function normalizeInput(query) {
    return String(query || "").replace(/\s+/g, " ").trim();
}

function countWords(query) {
    const text = normalizeInput(query);
    if (!text) {
        return 0;
    }

    return text.split(/\s+/).filter(Boolean).length;
}

function isLikelyCommandQuery(query) {
    const text = normalizeInput(query);
    if (!text) {
        return false;
    }

    if (COMMAND_VERBS.test(text)) {
        return true;
    }

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > 6) {
        return false;
    }

    return /^(turn|lock|unlock|open|close|start|stop|enable|disable|mute|unmute|increase|decrease|play|pause|resume|launch|restart|shutdown|reboot)\b/i.test(text);
}

function isFollowUpQuery(query) {
    const text = normalizeInput(query);
    if (!text) {
        return false;
    }

    return FOLLOW_UP_PRONOUNS.test(text) || FOLLOW_UP_RELATIVE.test(text) || FOLLOW_UP_IMPLICIT.test(text) || META_INSTRUCTION.test(text) || countWords(text) < 6;
}

function getRecentTurns(history, limit = 3) {
    if (!Array.isArray(history) || history.length === 0) {
        return [];
    }

    return history.slice(Math.max(0, history.length - limit));
}

function serializeRawToolData(rawToolData) {
    if (rawToolData === null || rawToolData === undefined) {
        return "(none)";
    }

    if (typeof rawToolData === "string") {
        return rawToolData.trim() || "(none)";
    }

    try {
        return JSON.stringify(rawToolData, null, 2);
    } catch (_) {
        return String(rawToolData);
    }
}

function summarizeTurn(turn) {
    const userQuery = normalizeInput(turn?.userQuery);
    const toolName = normalizeInput(turn?.toolName);
    const rawToolData = serializeRawToolData(turn?.rawToolData);
    const lines = [];

    if (userQuery) {
        lines.push(`User: ${userQuery}`);
    }

    if (toolName) {
        lines.push(`Tool: ${toolName}`);
    }

    if (rawToolData && rawToolData !== "(none)") {
        lines.push(`Tool raw data: ${rawToolData.slice(0, 2000)}`);
    }

    return lines.join("\n");
}

function buildRewritePrompt(history, query) {
    const recentTurns = getRecentTurns(history, 3);
    const compactHistory = recentTurns.map(summarizeTurn).filter(Boolean).join("\n\n");
    const normalizedQuery = normalizeInput(query);

    return [
        "You are a query rewriter for a voice assistant.",
        "Given the conversation history and a follow-up question, rewrite the follow-up into a fully self-contained search query that includes all necessary context.",
        "Output ONLY the rewritten query. No explanation. No punctuation at the end.",
        "Rules:",
        "- If the follow-up is a meta-instruction ('research that', 'find out', 'look it up', 'tell me more', 'dig deeper'), convert it to the actual specific search query the user means based on context.",
        "- Never output a meta-instruction as the rewritten query.",
        "- Always output a concrete, searchable query.",
        "- Include product names, model numbers, and specific details from history.",
        "",
        "History:",
        compactHistory || "(none)",
        "",
        `Follow-up: ${normalizedQuery}`,
        "",
        "Rewritten query:"
    ].join("\n");
}

function shouldRewriteQuery(query, history, workflowState) {
    if (workflowState) {
        return false;
    }

    if (!Array.isArray(history) || history.length === 0) {
        return false;
    }

    const normalized = normalizeInput(query);
    if (!normalized) {
        return false;
    }

    if (isLikelyCommandQuery(normalized)) {
        return false;
    }

    if (!isFollowUpQuery(normalized)) {
        return false;
    }

    return true;
}

function cleanRewriteResult(text) {
    return normalizeInput(text)
        .replace(/^['"`]+/, "")
        .replace(/['"`]+$/, "")
        .replace(/[.?!]+$/, "")
        .trim();
}

function levenshteinDistance(a, b) {
    const left = normalizeInput(a).toLowerCase();
    const right = normalizeInput(b).toLowerCase();

    if (left === right) {
        return 0;
    }

    if (!left.length) {
        return right.length;
    }

    if (!right.length) {
        return left.length;
    }

    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i++) {
        let current = [i];
        for (let j = 1; j <= right.length; j++) {
            const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + substitutionCost
            );
        }
        for (let j = 0; j <= right.length; j++) {
            previous[j] = current[j];
        }
    }

    return previous[right.length];
}

function rewriteDistanceRatio(original, rewritten) {
    const left = normalizeInput(original);
    const right = normalizeInput(rewritten);
    const maxLength = Math.max(left.length, right.length);
    if (maxLength === 0) {
        return 0;
    }

    return levenshteinDistance(left, right) / maxLength;
}

function truncateRewrite(text, maxLength = MAX_REWRITE_LENGTH) {
    const normalized = normalizeInput(text);
    if (normalized.length <= maxLength) {
        return normalized;
    }

    const sliced = normalized.slice(0, maxLength + 1);
    const cutIndex = sliced.lastIndexOf(" ");
    const trimmed = cutIndex > 0 ? sliced.slice(0, cutIndex) : normalized.slice(0, maxLength);
    return trimmed.replace(/[.?!,;:]+$/, "").trim();
}

function shouldKeepRewrite(originalQuery, rewrittenQuery) {
    const original = normalizeInput(originalQuery);
    const rewritten = normalizeInput(rewrittenQuery);
    if (!original || !rewritten) {
        return false;
    }

    const ratio = rewriteDistanceRatio(original, rewritten);
    if (ratio <= 0.2) {
        return false;
    }

    return true;
}

function finalizeRewrite(originalQuery, rewrittenQuery) {
    const cleaned = truncateRewrite(cleanRewriteResult(rewrittenQuery));
    if (!cleaned) {
        return normalizeInput(originalQuery);
    }

    if (!shouldKeepRewrite(originalQuery, cleaned)) {
        return normalizeInput(originalQuery);
    }

    return cleaned;
}

module.exports = {
    buildRewritePrompt,
    cleanRewriteResult,
    countWords,
    getRecentTurns,
    isFollowUpQuery,
    isLikelyCommandQuery,
    finalizeRewrite,
    shouldRewriteQuery
};