"use strict";

const { extractContent, formatExtractedContent } = require("../src/contentExtractor.js");

// ── Test URLs ─────────────────────────────────────────────────────────────────
// Swap these out for any links you want to probe.

const TEST_URLS = [
    {
        label: "YouTube — Rickroll",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    },
    {
        label: "YouTube short link",
        url: "https://youtu.be/dQw4w9WgXcQ",
    },
    {
        label: "Instagram post (login wall expected)",
        url: "https://www.instagram.com/p/Dc1l9dkFY_u/?utm_source=ig_web_copy_link",
    },
    {
        label: "Twitter/X post (login wall expected)",
        url: "https://x.com/drsdriven/status/2095823280133574727",
    },
    {
        label: "Generic article — Wikipedia",
        url: "https://en.wikipedia.org/wiki/Node.js",
    },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";
const DIM    = "\x1b[2m";

function banner(label) {
    const line = "─".repeat(60);
    console.log(`\n${CYAN}${line}${RESET}`);
    console.log(`${BOLD}  ${label}${RESET}`);
    console.log(`${CYAN}${line}${RESET}`);
}

function check(field, value) {
    const present = value && String(value).trim().length > 0;
    const icon    = present ? `${GREEN}✓${RESET}` : `${YELLOW}–${RESET}`;
    const display = present
        ? String(value).replace(/\s+/g, " ").substring(0, 120)
        : "(empty)";
    console.log(`  ${icon} ${BOLD}${field}:${RESET} ${DIM}${display}${RESET}`);
    return present;
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function runOne({ label, url }) {
    banner(label);
    console.log(`  ${DIM}URL: ${url}${RESET}`);

    const start = Date.now();
    let content;
    try {
        content = await extractContent(url);
    } catch (err) {
        console.log(`  ${RED}✗ extractContent threw: ${err.message}${RESET}`);
        return;
    }
    const elapsed = Date.now() - start;

    if (!content) {
        console.log(`  ${RED}✗ returned null (network failure or unsupported platform)${RESET}`);
        return;
    }

    console.log(`  ${DIM}elapsed: ${elapsed}ms  platform: ${content.platform}${RESET}\n`);

    const fields = {
        title:       content.title,
        description: content.description,
        duration:    content.duration,     // YouTube only
        thumbnail:   content.thumbnail || content.image,
        transcript:  content.transcript,   // YouTube only
        content:     content.content,      // generic articles
    };

    let filled = 0;
    for (const [field, value] of Object.entries(fields)) {
        if (check(field, value)) filled++;
    }

    console.log(`\n  ${BOLD}Formatted output (what the LLM sees):${RESET}`);
    const formatted = formatExtractedContent(content);
    const preview = formatted.replace(/\n/g, "\n  ").substring(0, 600);
    console.log(`  ${DIM}${preview}${formatted.length > 600 ? "\n  …" : ""}${RESET}`);

    const pct = Math.round((filled / Object.keys(fields).length) * 100);
    const color = pct >= 60 ? GREEN : pct >= 30 ? YELLOW : RED;
    console.log(`\n  ${color}${BOLD}Fields populated: ${filled}/${Object.keys(fields).length} (${pct}%)${RESET}`);
}

async function main() {
    console.log(`${BOLD}\nContentExtractor — live URL test${RESET}`);
    console.log(`Node ${process.version}  •  ${new Date().toISOString()}`);

    for (const tc of TEST_URLS) {
        await runOne(tc);
    }

    console.log(`\n${CYAN}${"─".repeat(60)}${RESET}`);
    console.log(`${BOLD}Done.${RESET}\n`);
}

main().catch(console.error);