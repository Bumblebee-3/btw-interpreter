const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class RAGManager {
  constructor(db, dataDir) {
    this.db = db;
    this.dataDir = dataDir;
    this.sourcesPath = path.resolve(dataDir, "..", "rag-sources.json");
  }

  readSources() {
    try {
      return JSON.parse(fs.readFileSync(this.sourcesPath, "utf8"));
    } catch (_) {
      this.writeSources([]);
      return [];
    }
  }

  writeSources(sources) {
    fs.mkdirSync(path.dirname(this.sourcesPath), { recursive: true });
    fs.writeFileSync(this.sourcesPath, JSON.stringify(sources, null, 2));
  }

  ensureDb() {
    if (!this.db || !this.db.dbPath) throw new Error("Knowledge base is not initialised.");
  }

  saveSource(record) {
    const sources = this.readSources().filter(source => source.source !== record.source);
    sources.push({ id: crypto.randomUUID(), ...record, addedAt: Date.now() });
    this.writeSources(sources);
  }

  async scanUrl(input) {
    const match = String(input).match(/https?:\/\/[^\s]+/);
    if (!match) return "Please provide a URL to scan, e.g. 'scan https://example.com'";
    const url = match[0].replace(/[),.;]+$/, "");
    const allPages = /entire site|all pages|crawl all/i.test(input);
    const maxPages = allPages ? 0 : 1;
    const maxDepth = allPages ? 2 : 0;
    const hostname = new URL(url).hostname;
    const prefixMatch = String(input).match(/\bas\s+(.+?)(?:\s+https?:\/\/|$)/i);
    const prefix = prefixMatch ? `${prefixMatch[1].trim()}: ` : `${hostname}: `;
    try {
      this.ensureDb();
      await this.db.deleteBySource("documents", url);
      const result = await this.db.addUrlToTable("documents", url, { maxPages, maxDepth, prefix });
      this.saveSource({ type: "url", source: url, label: hostname, table: "documents", chunks: result.inserted, pages: result.pages, prefix });
      return `Scanned ${result.pages} page(s) from ${url} and indexed ${result.inserted} chunks into the knowledge base.`;
    } catch (error) {
      return `Failed to scan ${url}: ${error.message}`;
    }
  }

  async scanFile(input) {
    const match = String(input).match(/\[FILE:path=(.*?),name=(.*?)\]/);
    if (!match) return "Please attach a file first, then ask me to scan it.";
    const filePath = match[1];
    const originalName = match[2];
    try {
      this.ensureDb();
      const prefix = `${originalName}: `;
      const result = await this.db.addFileToTable("documents", filePath, { prefix });
      this.saveSource({ type: "file", source: filePath, label: originalName, originalName, table: "documents", chunks: result.inserted, prefix });
      return `Indexed ${result.inserted} chunks from ${originalName} into the knowledge base.`;
    } catch (error) {
      if (/no extractable text/i.test(error.message) && /\.pdf$/i.test(originalName)) return "This PDF appears to be a scanned image with no extractable text.";
      if (/50 MB|too large/i.test(error.message)) return "File is too large to index (max 50MB).";
      return error.message;
    }
  }

  async listDatasets() {
    const sources = this.readSources();
    if (!sources.length) return "The knowledge base is empty. Ask me to scan a website or file to get started.";
    const lines = sources.map((source, index) => `${index + 1}. [${source.type.toUpperCase()}] ${source.label || source.source} — ${source.chunks || 0} chunks — added ${new Date(source.addedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
    return `Knowledge base contents (${sources.length} sources):\n\n${lines.join("\n")}`;
  }

  async removeSource(input) {
    const text = String(input);
    const url = text.match(/https?:\/\/[^\s]+/)?.[0]?.replace(/[),.;]+$/, "");
    const sources = this.readSources();
    const match = url ? sources.find(source => source.source === url) : sources.find(source => source.type === "file" && new RegExp(source.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text));
    if (!match) return "I couldn't identify what to remove. Try: 'remove https://example.com from knowledge base'";
    try {
      this.ensureDb();
      await this.db.deleteBySource(match.table, match.source);
      this.writeSources(sources.filter(source => source.id !== match.id));
      return `Removed ${match.label || match.source} from the knowledge base.`;
    } catch (error) {
      return `Failed to remove ${match.label || match.source}: ${error.message}`;
    }
  }
}

module.exports = RAGManager;
