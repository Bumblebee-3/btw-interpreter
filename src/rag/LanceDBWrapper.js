const lancedb = require("@lancedb/lancedb");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("@xenova/transformers");

class LanceDBWrapper {
  constructor(options = {}) {
    this.dbPath = options.dbPath || path.join(__dirname, "lancedb");
    this.db = null;
    this.embeddingDimension = 384; // MiniLM dimension
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
          vector: dummyVector,
        },
      ],
      { mode: "overwrite" }
    );

    await table.delete("id = 'init'");
    console.log(`Table "${tableName}" created.`);
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
