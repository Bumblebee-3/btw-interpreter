const { fetchUrl } = require("../contentExtractor");
const { cleanText } = require("./textChunker");

function getCheerio() {
  try {
    return require("cheerio");
  } catch (_) {
    throw new Error("cheerio is not installed. Run: npm install cheerio");
  }
}

function extractTextFromHtml(html) {
  const $ = getCheerio().load(html);
  $("script, style, noscript, nav, footer, header, .sidebar, .nav, .footer, .header, .menu, .cookie, .advertisement, .ad, [aria-hidden='true']").remove();
  $("[class*='nav'], [class*='menu'], [class*='footer'], [class*='header'], [class*='sidebar'], [id*='nav'], [id*='menu'], [id*='footer'], [id*='header'], [id*='sidebar']").remove();

  const selectors = ["main", "article", "[role='main']", ".content", ".main", ".docs", ".documentation", "#content", "#main"];
  for (const selector of selectors) {
    const found = $(selector);
    if (found.length && found.text().trim().length > 200) return cleanText(found.text());
  }
  return cleanText($("body").text());
}

function extractInternalLinks(html, baseUrl) {
  const $ = getCheerio().load(html);
  let base;
  try {
    base = new URL(baseUrl);
  } catch (_) {
    return [];
  }

  const links = new Set();
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.origin !== base.origin || resolved.pathname === base.pathname) return;
      resolved.hash = "";
      if (resolved.search.length > 50) resolved.search = "";
      links.add(resolved.toString());
    } catch (_) {
      // Ignore malformed links.
    }
  });
  return Array.from(links);
}

function isBinaryUrl(url) {
  return /\.(jpg|jpeg|png|gif|webp|svg|mp4|mp3|pdf|zip|tar|gz|woff|woff2|ttf|eot|ico|exe|dmg|pkg)$/i.test(String(url || "").split("?")[0]);
}

async function extractTextFromUrl(url) {
  if (isBinaryUrl(url)) throw new Error(`Skipping binary URL: ${url}`);
  const html = await fetchUrl(url, 15000);
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return {
    text: extractTextFromHtml(html),
    title: titleMatch ? cleanText(titleMatch[1]) : "",
    html,
    url,
  };
}

async function crawlUrl(startUrl, options = {}) {
  const maxPages = options.maxPages ?? 1;
  const maxDepth = options.maxDepth ?? 1;
  const allowedPrefixes = Array.isArray(options.allowedPathPrefixes) ? options.allowedPathPrefixes : [];
  const visited = new Set();
  const results = [];
  const queue = [{ url: startUrl, depth: 0 }];

  while (queue.length && (maxPages === 0 || results.length < maxPages)) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const page = await extractTextFromUrl(url);
      if (page.text.length >= 50) {
        results.push({ url, text: page.text, title: page.title });
        console.log(`[URLExtractor] Fetched: ${url} (${page.text.length} chars)`);
      } else {
        console.warn(`[URLExtractor] Skipping ${url}: insufficient text (${page.text.length} chars)`);
      }

      if (depth < maxDepth && (maxPages === 0 || results.length < maxPages)) {
        for (const link of extractInternalLinks(page.html, url)) {
          if (visited.has(link) || isBinaryUrl(link)) continue;
          if (allowedPrefixes.length) {
            const linkPath = new URL(link).pathname;
            if (!allowedPrefixes.some((prefix) => linkPath.startsWith(prefix))) continue;
          }
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    } catch (error) {
      console.warn(`[URLExtractor] Failed to fetch ${url}: ${error.message}`);
    }

    if (queue.length) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return results;
}

module.exports = { crawlUrl, extractTextFromUrl, extractInternalLinks, isBinaryUrl, extractTextFromHtml };
