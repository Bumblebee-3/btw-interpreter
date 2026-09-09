// src/interpreter/ragPlanner.js

const { callLLM, extractContent } = require("./llm.js");

const MAX_ITERATIONS = 3;
const MAX_SUB_QUERIES = 5;
const CHUNK_SIMILARITY_MIN = 25; // lower bar per-chunk since we're being targeted
const MAX_CONTEXT_CHARS = 12000;

/**
 * Decompose a complex query into targeted retrieval sub-queries.
 * Returns string[] of sub-queries, or null if the query is simple enough
 * that single-shot RAG is fine.
 */
async function planRetrievalSubqueries(query, obj) {
    const tableNames = obj.table_config ? Object.keys(obj.table_config) : [];
    const prompt = `You are a retrieval planner for a local knowledge base.
A user asked: ${JSON.stringify(query)}

Available knowledge base tables: ${JSON.stringify(tableNames)}

Your job: decide if answering this question requires fetching multiple distinct pieces of information from the knowledge base, or if it is simple enough to answer in one lookup.

If SIMPLE (single concept, direct factual lookup, conversational): respond with:
{"simple": true, "sub_queries": []}

If COMPLEX (requires multiple concepts, multi-step reasoning, code generation using a library/framework, etc.): break it into 2-${MAX_SUB_QUERIES} targeted retrieval queries. Each should be a short, specific search string that would find ONE piece of needed information. Order them from most foundational to most specific.

Respond ONLY with valid JSON:
{"simple": false, "sub_queries": ["query1", "query2", ...]}

Rules:
- Sub-queries must be search strings, not questions. E.g. "aoi.js bot setup basic structure" not "how do I set up a bot?"
- Each sub-query should retrieve something different and necessary.
- Do not exceed ${MAX_SUB_QUERIES} sub-queries.
- If the knowledge base tables don't seem relevant to the question at all, set simple=true.`;

    try {
        const payload = await callLLM(prompt, obj.llm_config);
        const raw = extractContent(payload, obj.llm_config.provider);
        const match = String(raw || "").match(/\{[\s\S]*\}/);
        if (!match) return null;
        const parsed = JSON.parse(match[0]);
        if (parsed.simple) return null;
        if (!Array.isArray(parsed.sub_queries) || parsed.sub_queries.length === 0) return null;
        return parsed.sub_queries.slice(0, MAX_SUB_QUERIES).filter(q => typeof q === "string" && q.trim());
    } catch (_) {
        return null;
    }
}

/**
 * Retrieve chunks for a single sub-query and filter to relevant ones.
 * Returns array of { text, similarity, subQuery } objects.
 */
async function retrieveForSubquery(subQuery, obj) {
    try {
        const results = await obj.db.searchDB(subQuery, 4, obj.table_config);
        if (!results || results.length === 0) return [];
        return results
            .filter(r => parseFloat(String(r.similarity || "0").replace("%", "")) >= CHUNK_SIMILARITY_MIN)
            .map(r => ({ text: r.text, similarity: r.similarity, subQuery }));
    } catch (_) {
        return [];
    }
}

/**
 * Deduplicate retrieved chunks by content fingerprint (first 120 chars).
 */
function deduplicateChunks(chunks) {
    const seen = new Set();
    return chunks.filter(chunk => {
        const key = chunk.text.slice(0, 120).replace(/\s+/g, " ").trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Check whether the accumulated context is sufficient to answer the query,
 * or whether we need additional retrieval. Returns:
 *   { sufficient: true }
 *   { sufficient: false, additional_queries: string[] }
 */
async function checkSufficiency(query, accumulatedChunks, iterationNumber, obj) {
    if (iterationNumber >= MAX_ITERATIONS) return { sufficient: true };

    const contextPreview = accumulatedChunks
        .slice(0, 8)
        .map(c => c.text.slice(0, 300))
        .join("\n---\n");

    const prompt = `You are evaluating whether retrieved context is sufficient to answer a user's question.

User question: ${JSON.stringify(query)}

Retrieved context so far (${accumulatedChunks.length} chunks):
${contextPreview}

Is the context sufficient to give a complete, accurate answer? If some critical information is still missing, what specific searches would fill the gap?

Respond ONLY with valid JSON:
{"sufficient": true}
OR
{"sufficient": false, "additional_queries": ["search1", "search2"]}

Rules:
- Be conservative: if the context covers the main need even imperfectly, say sufficient=true.
- additional_queries must be short targeted search strings, max 3.
- If this is iteration ${iterationNumber} of ${MAX_ITERATIONS}, prefer sufficient=true unless there's a critical gap.`;

    try {
        const payload = await callLLM(prompt, obj.llm_config);
        const raw = extractContent(payload, obj.llm_config.provider);
        const match = String(raw || "").match(/\{[\s\S]*\}/);
        if (!match) return { sufficient: true };
        const parsed = JSON.parse(match[0]);
        return {
            sufficient: Boolean(parsed.sufficient),
            additional_queries: Array.isArray(parsed.additional_queries)
                ? parsed.additional_queries.slice(0, 3)
                : []
        };
    } catch (_) {
        return { sufficient: true };
    }
}

/**
 * Build the final synthesis prompt from accumulated chunks.
 */
function buildSynthesisContext(accumulatedChunks) {
    let totalChars = 0;
    const selected = [];

    // Sort by similarity descending, then take until we hit the char cap
    const sorted = [...accumulatedChunks].sort((a, b) => {
        return parseFloat(String(b.similarity || "0").replace("%", ""))
             - parseFloat(String(a.similarity || "0").replace("%", ""));
    });

    for (const chunk of sorted) {
        if (totalChars + chunk.text.length > MAX_CONTEXT_CHARS) break;
        selected.push(chunk);
        totalChars += chunk.text.length;
    }

    return selected
        .map(c => `[Retrieved for: "${c.subQuery}"]\n${c.text}`)
        .join("\n\n---\n\n");
}

/**
 * Main entry point. Returns { context: string, chunks: object[] } if the
 * planning loop found useful context, or null if RAG isn't relevant.
 */
async function planAndRetrieve(query, obj) {
    if (!obj.db || !obj.db.dbPath) return null;

    // Step 1: Decide if we need multi-query retrieval
    const subQueries = await planRetrievalSubqueries(query, obj);
    if (!subQueries) return null; // planner said "simple" — fall back to existing tryRAGAnswer

    // Step 2: Iterative retrieval loop
    let allChunks = [];
    let currentQueries = subQueries;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const batchResults = await Promise.all(
            currentQueries.map(sq => retrieveForSubquery(sq, obj))
        );

        const newChunks = batchResults.flat();
        allChunks = deduplicateChunks([...allChunks, ...newChunks]);

        if (allChunks.length === 0) break;

        const sufficiency = await checkSufficiency(query, allChunks, iteration + 1, obj);
        if (sufficiency.sufficient) break;
        if (!sufficiency.additional_queries || sufficiency.additional_queries.length === 0) break;

        currentQueries = sufficiency.additional_queries;
    }

    if (allChunks.length === 0) return null;

    return {
        context: buildSynthesisContext(allChunks),
        chunks: allChunks
    };
}

module.exports = { planAndRetrieve };