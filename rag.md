# RAG Usage Guide

This project uses LanceDB for vector storage and `Xenova/all-MiniLM-L6-v2` for embeddings.
File and URL ingestion automatically extracts text, splits it into small overlapping chunks, embeds each chunk, and stores the chunks in a LanceDB table.

## Setup

From this directory:

```sh
npm install
```

The ingestion features require these runtime packages, which are already listed in `package.json`:

- `@lancedb/lancedb`
- `@xenova/transformers`
- `pdf-parse` for PDF files
- `cheerio` for HTML pages

The embedding model is downloaded and loaded the first time `loadDB()` or an embedding operation runs. This can take a little longer on the first request.

## Initialize the database

```js
const { Interpreter } = require("./src/index.js");

const interpreter = new Interpreter({
  groq_api_key: process.env.groq_api_key,
});

interpreter.loadDB("./lancedb");
const db = interpreter.db;
```

`loadDB()` must be called before using `interpreter.db` or the forwarding methods on `interpreter`.
The database directory is created or opened by LanceDB as needed.

## Add ordinary text

```js
await db.createTable("documents");
await db.addToTable("documents", "Arch Linux uses systemd as its init system.");
```

`addToTable()` stores one text item. Use the ingestion methods below for long files or web pages.

## Ingest a file

```js
const result = await db.addFileToTable(
  "documents",
  "./docs/project-plan.md"
);

console.log(result);
// { inserted: 3, skipped: 0, source: "/.../docs/project-plan.md", chunks: 3 }
```

Supported file types include:

- Markdown and text: `.md`, `.markdown`, `.txt`
- Code: `.js`, `.ts`, `.py`, `.rs`, `.go`, `.java`, `.c`, `.cpp`, and related formats
- Configuration/data: `.json`, `.yaml`, `.yml`, `.toml`, `.csv`, `.xml`, `.ini`, `.env`
- `.pdf`

Files must be smaller than 50 MB. Unsupported extensions fail with an error instead of being treated as text.

### File options

```js
await db.addFileToTable("documents", "./spec.pdf", {
  maxChars: 800,       // Maximum chunk size; default: 800
  overlapChars: 100,   // Context carried into the next chunk; default: 100
  minChars: 40,        // Ignore smaller chunks; default: 40
  prefix: "Project specs: ",
});
```

The `prefix` is added to every stored chunk and can improve retrieval context.

## Ingest a URL

Ingest one page:

```js
const result = await db.addUrlToTable(
  "documents",
  "https://example.com/specification"
);

console.log(result);
// { inserted: 4, skipped: 0, pages: 1 }
```

The extractor removes common page noise such as scripts, navigation, headers, footers, menus, advertisements, and hidden elements. It prefers `main`, `article`, and documentation content areas.

### Crawl internal pages

```js
await db.addUrlToTable("code_docs", "https://example.com/docs/", {
  maxPages: 20,
  maxDepth: 2,
  allowedPathPrefixes: ["/docs"],
  prefix: "Example documentation: ",
});
```

URL options:

- `maxPages`: Maximum pages to fetch. Default is `1`. Use `0` for unlimited pages within the crawl limits.
- `maxDepth`: Maximum internal-link depth. Default is `0` for one page, otherwise `1`.
- `allowedPathPrefixes`: Optional path allowlist such as `["/docs", "/api"]`.
- `maxChars`, `overlapChars`, `minChars`, and `prefix`: Same chunk options as file ingestion.

Only same-origin links are followed. Binary/media URLs such as images, archives, fonts, and PDFs are skipped. Requests are rate-limited between pages.

## Query the stored content

Query one table directly:

```js
const results = await db.queryTable(
  "documents",
  "What does the project specification require?",
  5
);

console.log(results);
```

Search all tables:

```js
const results = await db.searchDB(
  "How should the service be configured?",
  5,
  { documents: 8, code_docs: 5 }
);
```

The third argument controls how many candidates are retrieved from each table. Tables omitted from the object use a default of `5`; use `0` to skip a table.

The normal interpreter query path can also use the configured RAG tables after `loadDB()`:

```js
console.log(await interpreter.query("How should the service be configured?"));
```

## Use the Interpreter forwarding methods

The same ingestion operations are exposed directly on `Interpreter`:

```js
await interpreter.addFileToTable("documents", "./README.md");
await interpreter.addUrlToTable("documents", "https://example.com/docs");
await interpreter.deleteBySource("documents", "/absolute/path/to/README.md");
```

These methods throw a clear error if `loadDB()` has not been called first.

## Remove an ingested source

Each ingested row stores its exact source path or URL. Delete all chunks from that source before re-ingesting updated content:

```js
await db.deleteBySource("documents", "/absolute/path/to/project-plan.md");
await db.addFileToTable("documents", "./docs/project-plan.md");

await db.deleteBySource("code_docs", "https://example.com/docs/");
```

`deleteBySource()` returns `0` when the table does not exist. The source must match the stored value exactly; file sources are stored as absolute paths.

## Complete example

```js
const { Interpreter } = require("./src/index.js");

async function main() {
  const interpreter = new Interpreter({
    groq_api_key: process.env.groq_api_key,
  });

  interpreter.loadDB("./lancedb");

  await interpreter.addFileToTable("documents", "./docs/guide.md", {
    prefix: "Project guide: ",
  });

  await interpreter.addUrlToTable("documents", "https://example.com/docs", {
    maxPages: 5,
    maxDepth: 1,
    allowedPathPrefixes: ["/docs"],
  });

  const results = await interpreter.db.queryTable(
    "documents",
    "How do I configure the project?",
    5
  );
  console.log(results);
}

main().catch(console.error);
```

## Test with the aoi.js documentation site

The manual test at `test/aoi-rag.test.js` crawls the full same-origin `https://aoi.js.org/` site into the dedicated `aoijs_db` table and then lets you query the indexed documentation.

From the `interpreter` directory, run:

```sh
node test/aoi-rag.test.js --reset
```

The first run can take a while because it fetches pages and generates embeddings. You can provide a query directly:

```sh
node test/aoi-rag.test.js --no-ingest --query "How do I create a command in aoi.js?"
```

Without `--query`, the script prompts for a question. Use `--no-ingest` to query the existing `aoijs_db` table without crawling again. Use `--reset` before a fresh crawl to replace the dedicated AOI table instead of adding duplicate chunks.

## Notes

- Chunk IDs are deterministic for a given source filename/URL, chunk index, and content prefix, but repeated ingestion can still create duplicates. Delete the old source first when re-ingesting.
- Existing tables created before source metadata was added can still be queried. New ingested rows include `source` and `chunk_index` fields.
- The project currently has a `test` script pointing to a missing root `test.js`; use the focused module checks or the tests under `test/` when validating RAG changes.
