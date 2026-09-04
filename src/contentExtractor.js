"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const RETRYABLE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE"]);

// ─── fetchUrl ─────────────────────────────────────────────────────────────────
// Fetches a URL with redirect following, size capping, retries, and a hard
// wall-clock timeout that covers slow-drip servers (not just socket inactivity).

function fetchUrl(urlString, timeoutMs = 8000, redirectCount = 0, retries = 2) {
    return new Promise((resolve, reject) => {
        let settled = false;

        // Guards both resolve and reject so a destroy() + "end" race can't
        // call resolve after reject has already fired (or vice-versa).
        const settle = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(wallTimer);
            fn(value);
        };

        // Hard wall-clock timeout covering slow-drip responses.
        const wallTimer = setTimeout(() => {
            settle(reject, Object.assign(new Error("Request wall-clock timeout"), { code: "ETIMEDOUT" }));
        }, timeoutMs);

        const attempt = (attemptNum) => {
            if (settled) return;

            let urlObj;
            try {
                urlObj = new URL(urlString);
            } catch (err) {
                return settle(reject, err);
            }

            const protocol = urlObj.protocol === "https:" ? https : http;
            const options = {
                // Socket inactivity timeout (secondary guard).
                timeout: timeoutMs,
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
                        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            };

            const req = protocol.get(urlString, options, (res) => {
                const status = Number(res.statusCode || 0);
                const location = res.headers?.location;

                if (status >= 300 && status < 400 && location) {
                    res.resume();
                    if (redirectCount >= 5) {
                        return settle(reject, new Error("Too many redirects"));
                    }
                    const nextUrl = new URL(location, urlString).toString();
                    // Re-use remaining wall time for the redirect chain.
                    fetchUrl(nextUrl, timeoutMs, redirectCount + 1, retries)
                        .then((v) => settle(resolve, v))
                        .catch((e) => settle(reject, e));
                    return;
                }

                const contentLength = Number(res.headers["content-length"] || 0);
                if (contentLength && contentLength > MAX_BYTES) {
                    req.destroy();
                    return settle(reject, new Error("Response too large"));
                }

                const chunks = [];
                let totalBytes = 0;

                res.on("data", (chunk) => {
                    if (settled) return;
                    totalBytes += chunk.length;
                    if (totalBytes > MAX_BYTES) {
                        req.destroy();
                        return settle(reject, new Error("Response too large"));
                    }
                    chunks.push(chunk);
                });

                res.on("end", () => {
                    settle(resolve, Buffer.concat(chunks).toString("utf-8"));
                });

                res.on("error", (err) => settle(reject, err));
            });

            req.on("timeout", () => {
                req.destroy();
                // The "error" event fires after destroy; handled below.
            });

            req.on("error", (err) => {
                if (settled) return;
                const code = String(err.code || "");
                const msg = String(err.message || "").toLowerCase();
                const retryable =
                    RETRYABLE_CODES.has(code) || msg.includes("socket hang up");

                if (retryable && attemptNum < retries) {
                    const backoff = 250 * Math.pow(2, attemptNum);
                    setTimeout(() => attempt(attemptNum + 1), backoff);
                    return;
                }
                settle(reject, err);
            });
        };

        attempt(0);
    });
}

// ─── HTML utilities ───────────────────────────────────────────────────────────

/**
 * Decode both named and numeric XML/HTML entities.
 * The original only handled 6 named entities, leaving &#160;, &#8220;, etc. raw.
 */
function decodeXMLEntities(str) {
    if (!str) return "";
    return str
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, " ");
}

/**
 * Extract balanced tag blocks from HTML without regex truncation.
 * The original /<div...>([\s\S]*?)<\/div>/gi stopped at the FIRST </div>,
 * cutting off everything inside nested elements.
 */
function extractBalancedTags(html, tagName) {
    const results = [];
    const openRe = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "gi");
    const closeTag = `</${tagName}>`;
    let match;

    while ((match = openRe.exec(html)) !== null) {
        const contentStart = match.index + match[0].length;
        let depth = 1;
        let pos = contentStart;

        while (pos < html.length && depth > 0) {
            const nextOpen = html.indexOf(`<${tagName}`, pos);
            const nextClose = html.indexOf(closeTag, pos);

            if (nextClose === -1) break;

            if (nextOpen !== -1 && nextOpen < nextClose) {
                depth++;
                pos = nextOpen + 1;
            } else {
                depth--;
                if (depth === 0) {
                    results.push(html.slice(contentStart, nextClose));
                }
                pos = nextClose + closeTag.length;
            }
        }
    }

    return results;
}

function extractMetaTags(html) {
    const tags = {};
    const metaTagRegex = /<meta\s+[^>]*>/gi;
    let tagMatch;

    while ((tagMatch = metaTagRegex.exec(html)) !== null) {
        const tag = tagMatch[0];
        const attrs = {};
        const attrRegex =
            /([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^"'\s>]+))/g;
        let attrMatch;

        while ((attrMatch = attrRegex.exec(tag)) !== null) {
            const key = String(attrMatch[1] || "").toLowerCase();
            const val = attrMatch[2] || attrMatch[3] || attrMatch[4] || "";
            attrs[key] = val;
        }

        const content = attrs.content || "";
        if (!content) continue;
        if (attrs.property) tags[String(attrs.property).toLowerCase()] = decodeXMLEntities(content);
        if (attrs.name) tags[String(attrs.name).toLowerCase()] = decodeXMLEntities(content);
    }

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch && !tags.title) {
        tags.title = decodeXMLEntities(titleMatch[1]);
    }

    return tags;
}

function stripHtmlToText(html) {
    if (!html) return "";
    return decodeXMLEntities(
        html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
            .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ")
            .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    );
}

// Phrase list tightened to avoid destroying legitimate article content.
// E.g. "newsletter" was stripping content from articles that mentioned newsletters.
const BOILERPLATE_PHRASES = [
    /\bskip\s+to\s+content\b/gi,
    /\bsign\s+in\b/gi,
    /\bsubscribe\s+now\b/gi,
    /\badvertisement\b/gi,
    /\ball\s+rights\s+reserved\b/gi,
    /\bprivacy\s+policy\b/gi,
    /\bterms\s+of\s+(use|service)\b/gi,
    /\baccept\s+(all\s+)?cookies\b/gi,
];

function cleanBoilerplateText(text) {
    if (!text) return "";
    let cleaned = text;
    for (const phrase of BOILERPLATE_PHRASES) {
        cleaned = cleaned.replace(phrase, " ");
    }
    return cleaned.replace(/\s+/g, " ").trim();
}

// ─── Article extraction ───────────────────────────────────────────────────────

function extractJsonLdArticleBody(html) {
    if (!html) return "";
    const scriptRegex =
        /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = scriptRegex.exec(html)) !== null) {
        const jsonText = (match[1] || "").trim();
        if (!jsonText) continue;
        try {
            const parsed = JSON.parse(jsonText);
            const entries = Array.isArray(parsed) ? parsed : [parsed];
            for (const entry of entries) {
                if (!entry || typeof entry !== "object") continue;
                if (typeof entry.articleBody === "string" && entry.articleBody.length > 200) {
                    return cleanBoilerplateText(entry.articleBody);
                }
                for (const node of entry["@graph"] || []) {
                    if (typeof node?.articleBody === "string" && node.articleBody.length > 200) {
                        return cleanBoilerplateText(node.articleBody);
                    }
                }
            }
        } catch (_) {
            continue;
        }
    }
    return "";
}

function extractBestArticleTextFromHtml(html) {
    if (!html) return "";

    const jsonLdBody = extractJsonLdArticleBody(html);
    if (jsonLdBody) return jsonLdBody.substring(0, 7000);

    // Collect content from semantic containers using depth-aware extraction.
    const scopedBlocks = [
        ...extractBalancedTags(html, "article"),
        ...extractBalancedTags(html, "main"),
    ];

    // For <div>, filter to ones whose id/class suggests article content.
    const contentDivRe = /(?:id|class)=["'][^"']*(?:article|story|content|post|entry|main|body)[^"']*["']/i;
    for (const block of extractBalancedTags(html, "div")) {
        // Peek at the opening tag to check for content-indicating attributes.
        // extractBalancedTags gives us the inner HTML; we need a small look-back.
        // Simpler: test the full block prefix from the original HTML.
        if (contentDivRe.test(block.slice(0, 200))) {
            scopedBlocks.push(block);
        }
    }

    const sourceHtml = scopedBlocks.length ? scopedBlocks.join("\n") : html;
    const paragraphRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    const candidates = [];
    let m;

    while ((m = paragraphRegex.exec(sourceHtml)) !== null) {
        const text = cleanBoilerplateText(stripHtmlToText(m[1] || ""));
        if (text.length < 60) continue;

        const sentenceLikeCount = (text.match(/[.!?]\s/g) || []).length;
        const keywordBoost =
            /(said|according|study|report|health|video|official|research|court|police|doctor|patient|government)/i.test(
                text
            )
                ? 1
                : 0;
        const score =
            Math.min(text.length, 400) + sentenceLikeCount * 25 + keywordBoost * 35;
        candidates.push({ text, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    const combined = cleanBoilerplateText(
        candidates.slice(0, 12).map((c) => c.text).join(" ")
    );

    if (combined.length > 180) return combined.substring(0, 7000);

    const fallbackMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return cleanBoilerplateText(
        stripHtmlToText(fallbackMatch ? fallbackMatch[1] : html)
    ).substring(0, 5000);
}

// ─── Platform detection ───────────────────────────────────────────────────────

function detectPlatform(urlString) {
    try {
        const hostname = new URL(urlString).hostname.toLowerCase();
        if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) return "youtube";
        if (hostname.includes("reddit.com")) return "reddit";
        if (hostname.includes("linkedin.com")) return "linkedin";
        // Instagram and Twitter require auth/JS rendering; treat as generic
        // so we fall through to meta-tag extraction which still yields something.
    } catch (_) {}
    return "generic";
}

function extractYouTubeId(urlString) {
    try {
        const url = new URL(urlString);
        if (url.hostname.includes("youtube.com")) return url.searchParams.get("v");
        if (url.hostname.includes("youtu.be")) return url.pathname.slice(1).split("?")[0];
    } catch (_) {}
    return null;
}

// ─── YouTube ──────────────────────────────────────────────────────────────────

function extractYouTubeDuration(html) {
    // The page embeds duration in the ytInitialPlayerResponse JSON under
    // videoDetails, which appears before related-video entries.
    const playerDataMatch = html.match(
        /ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});(?:\s*(?:var|window|<))/
    );
    if (playerDataMatch) {
        try {
            const data = JSON.parse(playerDataMatch[1]);
            const secs = Number(data?.videoDetails?.lengthSeconds);
            if (secs > 0) {
                const mins = Math.floor(secs / 60);
                const rem = secs % 60;
                return `${mins}:${String(rem).padStart(2, "0")}`;
            }
        } catch (_) {}
    }

    // Fallback: first numeric "duration" string in the page.
    const m = html.match(/"lengthSeconds":"(\d+)"/);
    if (m) {
        const secs = parseInt(m[1]);
        return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    }
    return null;
}

// YouTube timedtext v1 API is 403 everywhere since late 2023.
// We now attempt the playerResponse timedtext endpoint that the web player uses.
async function fetchYouTubeTranscript(videoId) {
    try {
        // Fetch the watch page to pull the timedtext URL from ytInitialPlayerResponse.
        const html = await fetchUrl(`https://www.youtube.com/watch?v=${videoId}`, 8000);
        const playerMatch = html.match(
            /ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});(?:\s*(?:var|window|<))/
        );
        if (!playerMatch) return null;

        const data = JSON.parse(playerMatch[1]);
        const captionTracks =
            data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        const enTrack =
            captionTracks.find((t) => t.languageCode === "en") || captionTracks[0];
        if (!enTrack?.baseUrl) return null;

        const xml = await fetchUrl(enTrack.baseUrl, 5000);
        const textMatches = xml.match(/<text[^>]*>([^<]+)<\/text>/g) || [];

        const transcript = textMatches
            .map((t) => {
                const m = t.match(/>([^<]+)</);
                return m ? decodeXMLEntities(m[1]) : "";
            })
            .filter(Boolean)
            .join(" ");

        return transcript.substring(0, 3000) || null;
    } catch (_) {
        return null;
    }
}

async function extractYouTubeContent(urlString) {
    const videoId = extractYouTubeId(urlString);
    if (!videoId) return null;

    try {
        const html = await fetchUrl(`https://www.youtube.com/watch?v=${videoId}`, 8000);
        const metaTags = extractMetaTags(html);

        const content = {
            platform: "youtube",
            url: urlString,
            videoId,
            title: metaTags["og:title"] || "",
            description: metaTags["og:description"] || "",
            thumbnail: metaTags["og:image"] || "",
            duration: extractYouTubeDuration(html),
            transcript: null,
        };

        content.transcript = await fetchYouTubeTranscript(videoId);
        return content;
    } catch (err) {
        console.error(`[ContentExtractor] YouTube extraction failed: ${err.message}`);
        return null;
    }
}

// ─── Generic (covers Instagram/Twitter too — they wall off crawlers) ──────────

async function extractGenericContent(urlString) {
    try {
        const html = await fetchUrl(urlString, 8000);
        const metaTags = extractMetaTags(html);
        const mainText = extractBestArticleTextFromHtml(html);
        const cleanDescription = cleanBoilerplateText(
            metaTags["og:description"] || metaTags["description"] || ""
        );

        return {
            platform: "generic",
            url: urlString,
            title: metaTags["og:title"] || metaTags["title"] || "",
            description: cleanDescription,
            content: mainText,
            image: metaTags["og:image"] || "",
        };
    } catch (err) {
        console.error(`[ContentExtractor] Generic extraction failed: ${err.message}`);
        return null;
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function extractContent(urlString) {
    if (!urlString) return null;
    try {
        const platform = detectPlatform(urlString);
        if (platform === "youtube") return await extractYouTubeContent(urlString);
        return await extractGenericContent(urlString);
    } catch (err) {
        console.error(`[ContentExtractor] Failed to extract ${urlString}: ${err.message}`);
        return null;
    }
}

function extractLinksFromText(text) {
    if (!text) return [];
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    return (text.match(urlRegex) || [])
        .map((url) => {
            url = url.replace(/[.,!?;:)'"]+$/, "");
            try { new URL(url); return url; } catch (_) { return null; }
        })
        .filter(Boolean);
}

/**
 * Format extracted content for LLM consumption.
 * Previous limits (500 chars for content, 1000 for transcript) gave the LLM
 * almost nothing to work with. Limits raised to 4000 / 3000 respectively.
 */
function formatExtractedContent(content) {
    if (!content) return "";
    const parts = [];

    if (content.platform && content.platform !== "generic") {
        parts.push(`[${content.platform.toUpperCase()}]`);
    }
    if (content.title) parts.push(`Title: ${content.title}`);
    if (content.author) parts.push(`By: ${content.author}`);
    if (content.duration) parts.push(`Duration: ${content.duration}`);
    if (content.description) parts.push(`Description: ${content.description.substring(0, 800)}`);
    if (content.transcript) parts.push(`Transcript: ${content.transcript.substring(0, 3000)}`);
    if (content.content) parts.push(`Content: ${content.content.substring(0, 4000)}`);

    if (!content.title && !content.description && !content.content && !content.transcript) {
        parts.push(`URL: ${content.url || ""}`);
        parts.push("No preview metadata available from source.");
    }

    return parts.join("\n");
}

module.exports = {
    extractContent,
    extractLinksFromText,
    formatExtractedContent,
    detectPlatform,
    fetchUrl,
    // Exposed for unit testing.
    _internal: {
        decodeXMLEntities,
        extractBalancedTags,
        extractBestArticleTextFromHtml,
        cleanBoilerplateText,
        extractYouTubeDuration,
    },
};