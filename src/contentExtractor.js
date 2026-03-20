/**
 * Content Extractor for social media links and web content
 * Handles: YouTube, Instagram, Twitter/X, Facebook, TikTok, generic links
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");

/**
 * Fetch content from a URL with timeout and error handling
 */
function fetchUrl(urlString, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(urlString);
      const protocol = urlObj.protocol === "https:" ? https : http;

      const req = protocol.get(urlString, { timeout: timeoutMs }, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
          // Limit response size to 2MB to handle large social pages safely.
          if (data.length > 2 * 1024 * 1024) {
            req.destroy();
            reject(new Error("Response too large"));
          }
        });
        res.on("end", () => resolve(data));
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });

      req.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Extract meta tags from HTML
 */
function extractMetaTags(html) {
  const tags = {};
  const ogRegex = /<meta\s+property="og:([^"]+)"\s+content="([^"]*)"/gi;
  const metaRegex = /<meta\s+name="([^"]+)"\s+content="([^"]*)"/gi;

  let match;
  while ((match = ogRegex.exec(html)) !== null) {
    tags[`og:${match[1]}`] = match[2];
  }
  while ((match = metaRegex.exec(html)) !== null) {
    tags[match[1]] = match[2];
  }

  // Extract title if present
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch && !tags.title) {
    tags.title = titleMatch[1];
  }

  return tags;
}

/**
 * Extract YouTube video ID from URL
 */
function extractYouTubeId(urlString) {
  try {
    const url = new URL(urlString);
    if (url.hostname.includes("youtube.com")) {
      return url.searchParams.get("v");
    }
    if (url.hostname.includes("youtu.be")) {
      return url.pathname.slice(1).split("?")[0];
    }
  } catch (_) {}
  return null;
}

/**
 * Extract Instagram post/reel ID from URL
 */
function extractInstagramId(urlString) {
  try {
    const match = urlString.match(/(?:instagram\.com|instagr\.am)\/(?:p|reel)\/([A-Za-z0-9_-]+)/i);
    return match ? match[1] : null;
  } catch (_) {}
  return null;
}

/**
 * Extract Twitter/X tweet ID from URL
 */
function extractTwitterId(urlString) {
  try {
    const match = urlString.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/i);
    return match ? match[1] : null;
  } catch (_) {}
  return null;
}

/**
 * Detect platform from URL
 */
function detectPlatform(urlString) {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();

    if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) return "youtube";
    if (hostname.includes("instagram.com") || hostname.includes("instagr.am")) return "instagram";
    if (hostname.includes("twitter.com") || hostname.includes("x.com")) return "twitter";
    if (hostname.includes("facebook.com") || hostname.includes("fb.com")) return "facebook";
    if (hostname.includes("tiktok.com")) return "tiktok";
    if (hostname.includes("reddit.com")) return "reddit";
    if (hostname.includes("linkedin.com")) return "linkedin";
  } catch (_) {}
  return "generic";
}

/**
 * Extract YouTube video metadata and transcript
 */
async function extractYouTubeContent(urlString) {
  const videoId = extractYouTubeId(urlString);
  if (!videoId) return null;

  try {
    // Fetch video page to get metadata
    const html = await fetchUrl(`https://www.youtube.com/watch?v=${videoId}`, 8000);
    const metaTags = extractMetaTags(html);

    const content = {
      platform: "youtube",
      url: urlString,
      videoId,
      title: metaTags["og:title"] || "",
      description: metaTags["og:description"] || "",
      thumbnail: metaTags["og:image"] || "",
      duration: extractYouTubeDuration(html)
    };

    // Try to fetch transcript if available
    try {
      const transcript = await fetchYouTubeTranscript(videoId);
      content.transcript = transcript;
    } catch (_) {
      // Transcript not available, that's okay
    }

    return content;
  } catch (err) {
    console.error(`[ContentExtractor] YouTube extraction failed: ${err.message}`);
    return null;
  }
}

/**
 * Extract duration from YouTube HTML
 */
function extractYouTubeDuration(html) {
  const durationMatch = html.match(/"duration":"(\d+)"/);
  if (durationMatch) {
    const seconds = parseInt(durationMatch[1]);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }
  return null;
}

/**
 * Fetch YouTube caption/transcript using a free API
 * Note: This is a best-effort attempt; YouTube transcripts may not always be available
 */
async function fetchYouTubeTranscript(videoId) {
  try {
    // Use a simple approach: fetch captions info from YouTube
    const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`;
    const response = await fetchUrl(url, 5000);

    // Basic extraction of text between XML tags
    const textMatches = response.match(/<text[^>]*>([^<]+)<\/text>/g);
    if (!textMatches) return null;

    const transcript = textMatches
      .map((match) => {
        const textMatch = match.match(/>([^<]+)</);
        return textMatch ? decodeXMLEntities(textMatch[1]) : "";
      })
      .filter((text) => text.trim())
      .join(" ");

    return transcript.substring(0, 2000); // Limit to 2000 chars for storage
  } catch (err) {
    // Transcript API may not be available for all videos
    return null;
  }
}

/**
 * Decode XML entities
 */
function decodeXMLEntities(str) {
  const entities = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&nbsp;": " "
  };
  return str.replace(/&[a-zA-Z]+;/g, (match) => entities[match] || match);
}

/**
 * Extract Instagram content (basic metadata via OG tags)
 */
async function extractInstagramContent(urlString) {
  try {
    const html = await fetchUrl(urlString, 8000);
    const metaTags = extractMetaTags(html);

    return {
      platform: "instagram",
      url: urlString,
      title: metaTags["og:title"] || "",
      description: metaTags["og:description"] || "",
      image: metaTags["og:image"] || "",
      type: urlString.includes("/reel/") ? "reel" : "post"
    };
  } catch (err) {
    console.error(`[ContentExtractor] Instagram extraction failed: ${err.message}`);
    return null;
  }
}

/**
 * Extract Twitter/X content (basic metadata via OG tags)
 */
async function extractTwitterContent(urlString) {
  try {
    const html = await fetchUrl(urlString, 8000);
    const metaTags = extractMetaTags(html);

    return {
      platform: "twitter",
      url: urlString,
      title: metaTags["og:title"] || metaTags["title"] || "",
      description: metaTags["og:description"] || "",
      image: metaTags["og:image"] || "",
      author: extractTwitterAuthor(html) || ""
    };
  } catch (err) {
    console.error(`[ContentExtractor] Twitter extraction failed: ${err.message}`);
    return null;
  }
}

/**
 * Extract Twitter author from HTML
 */
function extractTwitterAuthor(html) {
  const match = html.match(/<meta\s+name="twitter:creator"\s+content="([^"]+)"/i);
  return match ? match[1] : null;
}

/**
 * Extract Facebook content (basic metadata via OG tags)
 */
async function extractFacebookContent(urlString) {
  try {
    const html = await fetchUrl(urlString, 8000);
    const metaTags = extractMetaTags(html);

    return {
      platform: "facebook",
      url: urlString,
      title: metaTags["og:title"] || "",
      description: metaTags["og:description"] || "",
      image: metaTags["og:image"] || "",
      type: metaTags["og:type"] || "post"
    };
  } catch (err) {
    console.error(`[ContentExtractor] Facebook extraction failed: ${err.message}`);
    return null;
  }
}

/**
 * Extract TikTok content (basic metadata via OG tags)
 */
async function extractTikTokContent(urlString) {
  try {
    const html = await fetchUrl(urlString, 8000);
    const metaTags = extractMetaTags(html);

    return {
      platform: "tiktok",
      url: urlString,
      title: metaTags["og:title"] || "",
      description: metaTags["og:description"] || "",
      video: metaTags["og:video"] || "",
      author: extractTikTokAuthor(html) || ""
    };
  } catch (err) {
    console.error(`[ContentExtractor] TikTok extraction failed: ${err.message}`);
    return null;
  }
}

/**
 * Extract TikTok author from HTML
 */
function extractTikTokAuthor(html) {
  const match = html.match(/"author":"([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * Extract generic web content (title, description, main text)
 */
async function extractGenericContent(urlString) {
  try {
    const html = await fetchUrl(urlString, 8000);
    const metaTags = extractMetaTags(html);

    // Extract main text content (very basic)
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    let mainText = "";

    if (bodyMatch) {
      // Remove scripts and styles
      let cleanHtml = bodyMatch[1]
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ");

      // Decode entities and clean up
      mainText = decodeXMLEntities(cleanHtml)
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 1500); // Limit to 1500 chars
    }

    return {
      platform: "generic",
      url: urlString,
      title: metaTags["og:title"] || metaTags["title"] || "",
      description: metaTags["og:description"] || metaTags["description"] || "",
      content: mainText,
      image: metaTags["og:image"] || ""
    };
  } catch (err) {
    console.error(`[ContentExtractor] Generic extraction failed: ${err.message}`);
    return null;
  }
}

/**
 * Extract all links from text message
 */
function extractLinksFromText(text) {
  if (!text) return [];

  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const matches = text.match(urlRegex) || [];

  return matches.map((url) => {
    // Clean up trailing punctuation
    url = url.replace(/[.,!?;:)'"]+$/, "");
    try {
      new URL(url); // Validate URL
      return url;
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Main function: Extract content from URL
 */
async function extractContent(urlString) {
  if (!urlString) return null;

  const platform = detectPlatform(urlString);

  try {
    switch (platform) {
      case "youtube":
        return await extractYouTubeContent(urlString);
      case "instagram":
        return await extractInstagramContent(urlString);
      case "twitter":
        return await extractTwitterContent(urlString);
      case "facebook":
        return await extractFacebookContent(urlString);
      case "tiktok":
        return await extractTikTokContent(urlString);
      default:
        return await extractGenericContent(urlString);
    }
  } catch (err) {
    console.error(`[ContentExtractor] Failed to extract ${urlString}: ${err.message}`);
    return null;
  }
}

/**
 * Generate a summary-friendly text from extracted content
 */
function formatExtractedContent(content) {
  if (!content) return "";

  const parts = [];

  if (content.platform !== "generic") {
    parts.push(`[${content.platform.toUpperCase()}]`);
  }

  if (content.title) parts.push(`Title: ${content.title}`);
  if (content.author) parts.push(`By: ${content.author}`);
  if (content.duration) parts.push(`Duration: ${content.duration}`);

  if (content.description) {
    parts.push(`Description: ${content.description.substring(0, 500)}`);
  }

  if (content.transcript) {
    parts.push(`Transcript: ${content.transcript.substring(0, 1000)}...`);
  }

  if (content.content) {
    // For generic web content
    parts.push(`Content: ${content.content.substring(0, 500)}...`);
  }

  return parts.join("\n");
}

module.exports = {
  extractContent,
  extractLinksFromText,
  formatExtractedContent,
  detectPlatform,
  fetchUrl
};
