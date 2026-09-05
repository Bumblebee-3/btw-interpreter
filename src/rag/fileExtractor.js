const fs = require("fs");
const path = require("path");
const { cleanText } = require("./textChunker");

const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".py", ".rb", ".php", ".java", ".c", ".cpp", ".h", ".hpp", ".rs", ".go",
  ".swift", ".kt", ".toml", ".yaml", ".yml", ".json", ".jsonc", ".csv", ".tsv",
  ".html", ".xml", ".sh", ".bash", ".zsh", ".env", ".ini", ".cfg", ".sql",
]);

async function extractTextFromFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Path is not a file: ${resolved}`);
  if (stat.size > 50 * 1024 * 1024) {
    throw new Error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max is 50MB.`);
  }

  const ext = path.extname(resolved).toLowerCase();
  const metadata = { source: resolved, filename: path.basename(resolved), ext, type: "file" };
  if (ext === ".pdf") return { text: await extractPdf(resolved), metadata };
  if (TEXT_EXTENSIONS.has(ext) || ext === "") {
    return { text: cleanText(fs.readFileSync(resolved, "utf8")), metadata };
  }
  throw new Error(`Unsupported file type: ${ext}. Supported: PDF, Markdown, plain text, code files.`);
}

async function extractPdf(filePath) {
  let pdfParse;
  try {
    pdfParse = require("pdf-parse");
  } catch (_) {
    throw new Error("pdf-parse is not installed. Run: npm install pdf-parse");
  }

  const buffer = fs.readFileSync(filePath);
  if (typeof pdfParse === "function") {
    const data = await pdfParse(buffer);
    return cleanText(data.text || "");
  }
  if (pdfParse.PDFParse) {
    const parser = new pdfParse.PDFParse({ data: buffer });
    try {
      const data = await parser.getText();
      return cleanText(data.text || "");
    } finally {
      await parser.destroy();
    }
  }
  throw new Error("Unsupported pdf-parse API");
}

module.exports = { extractTextFromFile };
