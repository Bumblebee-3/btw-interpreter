#!/usr/bin/env node


// cd /home/bumblebee/Desktop/btw-voiceassistant/interpreter
// node test/aoi-rag.test.js --reset


// node test/aoi-rag.test.js --no-ingest --query "How do I create a command in aoi.js?"
const readline = require("readline");
const path = require("path");
const LanceDBWrapper = require("../src/rag/LanceDBWrapper");

const SITE_URL = "https://aoi.js.org/";
const TABLE_NAME = "aoijs_db";
const DB_PATH = path.resolve(__dirname, "../lancedb");

function parseArgs(argv) {
  const options = { reset: false, ingest: true, query: "" };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--reset") {
      options.reset = true;
    } else if (argument === "--no-ingest") {
      options.ingest = false;
    } else if (argument === "--query") {
      options.query = argv.slice(index + 1).join(" ").trim();
      break;
    } else if (!argument.startsWith("-")) {
      options.query = argv.slice(index).join(" ").trim();
      break;
    }
  }

  return options;
}

function askForQuery() {
  if (!process.stdin.isTTY) {
    return Promise.resolve("How do I create a command in aoi.js?");
  }

  const prompt = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    prompt.question("Ask a question about aoi.js: ", (answer) => {
      prompt.close();
      resolve(answer.trim() || "How do I create a command in aoi.js?");
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = new LanceDBWrapper({ dbPath: DB_PATH });

  if (options.reset) {
    const tables = await db.getAllTables();
    if (tables.includes(TABLE_NAME)) {
      await db.deleteTable(TABLE_NAME);
      console.log(`Deleted existing table: ${TABLE_NAME}`);
    }
  }

  if (options.ingest) {
    console.log(`Crawling the full same-origin site ${SITE_URL}`);
    console.log("This may take a while. Use --no-ingest to query existing data.");

    const result = await db.addUrlToTable(TABLE_NAME, SITE_URL, {
      maxPages: 0,
      maxDepth: 20,
      maxChars: 800,
      overlapChars: 100,
      minChars: 40,
      prefix: "aoi.js documentation: ",
    });

    console.log(
      `Ingestion complete: ${result.inserted} chunks inserted, ` +
      `${result.skipped} skipped across ${result.pages} pages.`
    );
  }

  const query = options.query || await askForQuery();
  const results = await db.queryTable(TABLE_NAME, query, 5);

  console.log(`\nQuery: ${query}\n`);
  if (!results.length) {
    console.log("No matching results found.");
    return;
  }

  results.forEach((result, index) => {
    console.log(`--- Result ${index + 1} (${result.similarity}) ---`);
    console.log(result.text);
    console.log(`Chunk ID: ${result.id}\n`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`AOI RAG test failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, askForQuery, main };
