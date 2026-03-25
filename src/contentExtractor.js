const https = require("https");
const http = require("http");
const { URL } = require("url");

function fetchUrl(urlString, timeoutMs = 8000, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(urlString);
      const protocol = urlObj.protocol === "https:" ? https : http;
      const options = {
        timeout: timeoutMs,
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9"
        }
      };

      const req = protocol.get(urlString, options, (res) => {
        const status = Number(res.statusCode || 0);
        const location = res.headers?.location;

        if (status >= 300 && status < 400 && location) {
          if (redirectCount >= 5) {
            reject(new Error("Too many redirects"));
            return;
          }

          const nextUrl = new URL(location, urlString).toString();
          res.resume();
          fetchUrl(nextUrl, timeoutMs, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        const chunks = [];
        let totalBytes = 0;
        res.on("data", (chunk) => {
          chunks.push(chunk);
          totalBytes += chunk.length;
          if (totalBytes > 2 * 1024 * 1024) {
            req.destroy();
            reject(new Error("Response too large"));
          }
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
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


function extractMetaTags(html) {
  const tags = {};
  const metaTagRegex = /<meta\s+[^>]*>/gi;

  let tagMatch;
  while ((tagMatch = metaTagRegex.exec(html)) !== null) {
    const tag = tagMatch[0];
    const attrs = {};
    const attrRegex = /([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^"'\s>]+))/g;

    let attrMatch;
    while ((attrMatch = attrRegex.exec(tag)) !== null) {
      const key = String(attrMatch[1] || "").toLowerCase();
      const val = attrMatch[2] || attrMatch[3] || attrMatch[4] || "";
      attrs[key] = val;
    }

    const content = attrs.content || "";
    if (!content) continue;

    if (attrs.property) {
      tags[String(attrs.property).toLowerCase()] = decodeXMLEntities(content);
    }
    if (attrs.name) {
      tags[String(attrs.name).toLowerCase()] = decodeXMLEntities(content);
    }
  }

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch && !tags.title) {
    tags.title = decodeXMLEntities(titleMatch[1]);
  }

  return tags;
}

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

function extractInstagramId(urlString) {
  try {
    const match = urlString.match(/(?:instagram\.com|instagr\.am)\/(?:p|reel)\/([A-Za-z0-9_-]+)/i);
    return match ? match[1] : null;
  } catch (_) {}
  return null;
}


function extractTwitterId(urlString) {
  try {
    const match = urlString.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/i);
    return match ? match[1] : null;
  } catch (_) {}
  return null;
}


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
      duration: extractYouTubeDuration(html)
    };

    try {
      const transcript = await fetchYouTubeTranscript(videoId);
      content.transcript = transcript;
    } catch (_) {
    }

    return content;
  } catch (err) {
    console.error(`[ContentExtractor] YouTube extraction failed: ${err.message}`);
    return null;
  }
}

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


async function fetchYouTubeTranscript(videoId) {
  try {
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

    return transcript.substring(0, 2000);
  } catch (err) {
    return null;
  }
}

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

function cleanBoilerplateText(text) {
  if (!text) return "";

  const noisyPhrases = [
    /skip\s+to\s+content/gi,
    /today'?s\s+paper/gi,
    /newsletter(s)?/gi,
    /sign\s+in/gi,
    /subscribe/gi,
    /advertisement/gi,
    /all rights reserved/gi,
    /privacy policy/gi,
    /terms of use/gi,
    /cookie(s)?/gi
  ];

  let cleaned = text;
  for (const phrase of noisyPhrases) {
    cleaned = cleaned.replace(phrase, " ");
  }

  return cleaned.replace(/\s+/g, " ").trim();
}

function extractJsonLdArticleBody(html) {
  if (!html) return "";

  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    const jsonText = (match[1] || "").trim();
    if (!jsonText) continue;

    try {
      const parsed = JSON.parse(jsonText);
      const entries = Array.isArray(parsed) ? parsed : [parsed];

      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;

        if (entry.articleBody && typeof entry.articleBody === "string") {
          const text = cleanBoilerplateText(entry.articleBody);
          if (text.length > 200) return text;
        }

        if (entry["@graph"] && Array.isArray(entry["@graph"])) {
          for (const node of entry["@graph"]) {
            if (node && typeof node.articleBody === "string") {
              const graphText = cleanBoilerplateText(node.articleBody);
              if (graphText.length > 200) return graphText;
            }
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

  const articleBodyFromJsonLd = extractJsonLdArticleBody(html);
  if (articleBodyFromJsonLd) {
    return articleBodyFromJsonLd.substring(0, 7000);
  }

  const scopedBlocks = [];
  const containerRegexes = [
    /<article[^>]*>([\s\S]*?)<\/article>/gi,
    /<main[^>]*>([\s\S]*?)<\/main>/gi,
    /<div[^>]*(?:id|class)=["'][^"']*(?:article|story|content|post|entry|main|body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi
  ];

  for (const regex of containerRegexes) {
    let match;
    while ((match = regex.exec(html)) !== null) {
      if (match[1]) scopedBlocks.push(match[1]);
    }
  }

  const sourceHtml = scopedBlocks.length ? scopedBlocks.join("\n") : html;
  const paragraphRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const candidates = [];
  let paragraphMatch;

  while ((paragraphMatch = paragraphRegex.exec(sourceHtml)) !== null) {
    const text = cleanBoilerplateText(stripHtmlToText(paragraphMatch[1] || ""));
    if (text.length < 60) continue;

    const sentenceLikeCount = (text.match(/[.!?]\s/g) || []).length;
    const keywordBoost = /(said|according|study|report|health|video|official|research|court|police|doctor|patient|government)/i.test(text) ? 1 : 0;
    const score = Math.min(text.length, 400) + sentenceLikeCount * 25 + keywordBoost * 35;
    candidates.push({ text, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 8).map((c) => c.text);
  const combined = cleanBoilerplateText(top.join(" "));

  if (combined.length > 180) {
    return combined.substring(0, 7000);
  }

  const fallbackBodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const fallbackText = cleanBoilerplateText(stripHtmlToText(fallbackBodyMatch ? fallbackBodyMatch[1] : html));
  return fallbackText.substring(0, 5000);
}

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

function extractTwitterAuthor(html) {
  const match = html.match(/<meta\s+name="twitter:creator"\s+content="([^"]+)"/i);
  return match ? match[1] : null;
}

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

function extractTikTokAuthor(html) {
  const match = html.match(/"author":"([^"]+)"/);
  return match ? match[1] : null;
}

async function extractGenericContent(urlString) {
  try {
    const html = await fetchUrl(urlString, 8000);
    const metaTags = extractMetaTags(html);

    const mainText = extractBestArticleTextFromHtml(html);
    const cleanDescription = cleanBoilerplateText(metaTags["og:description"] || metaTags["description"] || "");

    return {
      platform: "generic",
      url: urlString,
      title: metaTags["og:title"] || metaTags["title"] || "",
      description: cleanDescription,
      content: mainText,
      image: metaTags["og:image"] || ""
    };
  } catch (err) {
    console.error(`[ContentExtractor] Generic extraction failed: ${err.message}`);
    return null;
  }
}

function extractLinksFromText(text) {
  if (!text) return [];

  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const matches = text.match(urlRegex) || [];

  return matches.map((url) => {
    url = url.replace(/[.,!?;:)'"]+$/, "");
    try {
      new URL(url);
      return url;
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

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
    parts.push(`Content: ${content.content.substring(0, 500)}...`);
  }

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
  fetchUrl
};
