
const lancedb = require("@lancedb/lancedb");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("@xenova/transformers");
const { chunkText } = require("./textChunker");
const { extractTextFromFile } = require("./fileExtractor");
const { crawlUrl } = require("./urlExtractor");

class LanceDBWrapper {
  constructor(options = {}) {
    this.dbPath = options.dbPath || path.join(__dirname, "lancedb");
    this.db = null;
    this.embeddingDimension = 384;
    this.embedder = null;
  }

  async init() {
    if (!this.db) {
      this.db = await lancedb.connect(this.dbPath);
    }

    if (!this.embedder) {
      console.log("Loading MiniLM model (first time may take ~10s)...");
      this.embedder = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2"
      );
      console.log("Embedding model loaded.");
    }
  }

  
  async getAllTables() {
    await this.init();
    return await this.db.tableNames();
  }

  async generateEmbedding(text) {
    await this.init();

    const output = await this.embedder(text, {
      pooling: "mean",
      normalize: true,
    });

    return Array.from(output.data);
  }

  async createTable(tableName) {
    await this.init();

    const dummyVector = new Array(this.embeddingDimension).fill(0);

    const table = await this.db.createTable(
      tableName,
      [
        {
          id: "init",
          text: "init",
          source: "",
          chunk_index: 0,
          vector: dummyVector,
        },
      ],
      { mode: "overwrite" }
    );

    await table.delete("id = 'init'");
    console.log(`Table "${tableName}" created.`);
  }

  async ensureTable(tableName) {
    await this.init();
    const tables = await this.db.tableNames();
    if (!tables.includes(tableName)) await this.createTable(tableName);
  }

  async addToTable(tableName, text, id = null) {
    await this.init();
    const table = await this.db.openTable(tableName);

    const vector = await this.generateEmbedding(text);

    await table.add([
      {
        id: id || crypto.randomUUID(),
        text,
        vector,
      },
    ]);
  }

  async addFileToTable(tableName, filePath, options = {}) {
    await this.ensureTable(tableName);
    const { text, metadata } = await extractTextFromFile(filePath);
    if (!text.trim()) throw new Error(`No extractable text found in file: ${filePath}`);

    const chunks = chunkText(text, options);
    if (!chunks.length) throw new Error(`File produced no usable chunks after extraction: ${filePath}`);
    const table = await this.db.openTable(tableName);
    const prefix = options.prefix ? String(options.prefix) : "";
    let inserted = 0;
    let skipped = 0;

    for (let index = 0; index < chunks.length; index++) {
      const fullText = prefix + chunks[index];
      const id = `file:${metadata.filename}:chunk:${index}:${Buffer.from(fullText.slice(0, 40)).toString("hex").slice(0, 12)}`;
      try {
        await table.add([{
          id,
          text: fullText,
          source: metadata.source,
          chunk_index: index,
          vector: await this.generateEmbedding(fullText),
        }]);
        inserted++;
      } catch (error) {
        console.warn(`[LanceDB] Failed to insert chunk ${index} from ${filePath}: ${error.message}`);
        skipped++;
      }
    }
    return { inserted, skipped, source: metadata.source, chunks: chunks.length };
  }

  async addUrlToTable(tableName, url, options = {}) {
    await this.ensureTable(tableName);
    const maxPages = options.maxPages ?? 1;
    const pages = await crawlUrl(url, {
      maxPages,
      maxDepth: options.maxDepth ?? (maxPages === 1 ? 0 : 1),
      allowedPathPrefixes: options.allowedPathPrefixes,
    });
    if (!pages.length) throw new Error(`No content could be extracted from URL: ${url}`);

    const table = await this.db.openTable(tableName);
    const prefix = options.prefix ? String(options.prefix) : "";
    let inserted = 0;
    let skipped = 0;
    for (const page of pages) {
      const chunks = chunkText(page.text, options);
      for (let index = 0; index < chunks.length; index++) {
        const context = page.title ? `[${page.title}] ` : "";
        const fullText = prefix + context + chunks[index];
        const id = `url:${encodeURIComponent(page.url).slice(0, 60)}:chunk:${index}:${Buffer.from(fullText.slice(0, 40)).toString("hex").slice(0, 12)}`;
        try {
          await table.add([{
            id,
            text: fullText,
            source: page.url,
            chunk_index: index,
            vector: await this.generateEmbedding(fullText),
          }]);
          inserted++;
        } catch (error) {
          console.warn(`[LanceDB] Failed to insert chunk ${index} from ${page.url}: ${error.message}`);
          skipped++;
        }
      }
    }
    return { inserted, skipped, pages: pages.length };
  }

  async deleteBySource(tableName, source) {
    await this.init();
    if (!(await this.db.tableNames()).includes(tableName)) return 0;
    const table = await this.db.openTable(tableName);
    const escaped = String(source || "").replace(/'/g, "''");
    await table.delete(`source = '${escaped}'`);
    return undefined;
  }

  async queryTable(tableName, queryText, limit = 5) {
    await this.init();
    const table = await this.db.openTable(tableName);

    const queryVector = await this.generateEmbedding(queryText);

    const results = await table
      .search(queryVector)
      .limit(limit)
      .toArray();

    return results.map((r) => ({
      id: r.id,
      text: r.text,
      similarity: ((1 - r._distance) * 100).toFixed(2) + "%",
    }));
  }

  async deleteTable(tableName) {
    await this.init();
    await this.db.dropTable(tableName);
    console.log(`Table "${tableName}" deleted.`);
  }

  async searchDB(question, max = 5, table_config = {}) {
    const tables = await this.getAllTables();
    let allResults = [];

    for (const tableName of tables) {
      if (table_config[tableName] == null) table_config[tableName] = 5;
      if (table_config[tableName] === 0) continue;

      const results = await this.queryTable(
        tableName,
        question,
        table_config[tableName]
      );

      for (const result of results) {
        allResults.push({
          text: result.text,
          similarity: parseFloat(result.similarity.replace("%", "")),
        });
      }
    }

    allResults.sort((a, b) => b.similarity - a.similarity);
    return allResults.slice(0, max);
  }
}

module.exports = LanceDBWrapper;
