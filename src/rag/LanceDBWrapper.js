const lancedb = require("@lancedb/lancedb");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require("path");
const crypto = require("crypto");

class LanceDBWrapper {
  constructor(options = {}) {
    this.dbPath = options.dbPath || path.join(__dirname, "lancedb");
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY;

    if (!this.apiKey) throw new Error("GEMINI_API_KEY missing");

    this.genAI = new GoogleGenerativeAI(this.apiKey);
    this.embeddingModel = this.genAI.getGenerativeModel({model: "gemini-embedding-001"});
    this.db = null;
    this.embeddingDimension = null;
  }

  async init() {
    if (!this.db) this.db = await lancedb.connect(this.dbPath);

    if (!this.embeddingDimension) {
      const test = await this.generateEmbedding("dimension check");
      this.embeddingDimension = test.length;
    }
  }
  async getAllTables() {
    await this.init();
    return await this.db.tableNames();
  }

  async generateEmbedding(text) {
    const result = await this.embeddingModel.embedContent(text);
    return result.embedding.values;
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

    // Return human readable results
    return results.map(r => ({
      id: r.id,
      text: r.text,
      similarity: ((1 - r._distance) * 100).toFixed(2) + "%"
    }));
  }

  async deleteTable(tableName) {
    await this.init();
    await this.db.dropTable(tableName);
    console.log(`Table "${tableName}" deleted.`);
  }

  async searchDB(question, max = 5) {
    const db = this;
    const tables = await db.getAllTables();
    let allResults = [];

    for (const tableName of tables) {
        const results = await db.queryTable(tableName, question, max);
        for (const result of results) {
          allResults.push({
            text: result.text,
            similarity: parseFloat(result.similarity.replace("%", ""))
          });
        }
      }
      allResults.sort((a, b) => b.similarity - a.similarity);
      const topResults = allResults.slice(0, max);
      return(topResults);
  }
}

module.exports = LanceDBWrapper;
