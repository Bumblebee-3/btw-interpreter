const BrowserController = require("./BrowserController");
const messageHistory = require("../../src/messageHistory");

const shared = {
	controller: null,
	initialized: false,
	headless: false,
	pending: null,
	lastSeen: null,
	lastOpenedUrl: ""
};

function normalize(value) {
	return String(value || "").trim();
}

function isLikelySelector(value) {
	const text = normalize(value);
	if (!text) return false;
	if (text.startsWith("#") || text.startsWith(".") || text.startsWith("[") || text.startsWith("//")) return true;
	if (/>|:nth|\s+>|\[.+\]|\w+\.\w+/.test(text)) return true;
	return false;
}

function parseBoolean(value, fallback = false) {
	if (typeof value === "boolean") return value;
	const text = normalize(value).toLowerCase();
	if (["true", "yes", "y", "1"].includes(text)) return true;
	if (["false", "no", "n", "0"].includes(text)) return false;
	return fallback;
}

function toSafeUrl(value) {
	const raw = normalize(value);
	if (!raw) return "";

	if (/\s/.test(raw)) return "";

	let candidate = raw;
	if (!/^https?:\/\//i.test(candidate)) {
		candidate = `https://${candidate}`;
	}

	try {
		const parsed = new URL(candidate);
		if (!parsed.hostname || !parsed.hostname.includes(".")) {
			return "";
		}
		return parsed.toString();
	} catch (_) {
		return "";
	}
}

function extractFirstUrl(text) {
	const raw = String(text || "");
	if (!raw) return "";
	const match = raw.match(/https?:\/\/[^\s\]\)"']+/i);
	return match ? normalize(match[0]) : "";
}

function cleanOpenTarget(text) {
	return normalize(text)
		.replace(/[.?!]+$/g, "")
		.replace(/^to\s+/i, "")
		.trim();
}

function isReferentialOpenTarget(target) {
	const raw = normalize(target).toLowerCase();
	if (!raw) return true;
	return /^(it|that|this|that link|this link|the link|link|one|that one|this one)$/.test(raw);
}

function pickByIndex(input, list) {
	const raw = normalize(input).toLowerCase();
	if (!raw) return null;
	const match = raw.match(/(?:option\s*)?(\d{1,2})/i);
	let idx = -1;

	if (match) {
		idx = Number(match[1]) - 1;
	} else {
		const wordToIndex = {
			one: 0,
			first: 0,
			two: 1,
			second: 1,
			three: 2,
			third: 2,
			four: 3,
			fourth: 3,
			five: 4,
			fifth: 4,
			six: 5,
			sixth: 5
		};

		for (const [word, mapped] of Object.entries(wordToIndex)) {
			if (new RegExp(`\\b${word}\\b`, "i").test(raw)) {
				idx = mapped;
				break;
			}
		}
	}

	if (idx < 0 || idx >= list.length) return null;
	return list[idx];
}

function summarizeCandidates(candidates) {
	return candidates
		.slice(0, 6)
		.map((item, idx) => `${idx + 1}. ${item.type} \"${item.text}\" (${item.selector})`)
		.join("; ");
}

function getOrdinalIndex(text) {
	const raw = normalize(text).toLowerCase();
	if (!raw) return -1;

	const numeric = raw.match(/(?:option\s*)?(\d{1,2})/i);
	if (numeric) return Math.max(0, Number(numeric[1]) - 1);

	const ordinals = {
		first: 0,
		second: 1,
		third: 2,
		fourth: 3,
		fifth: 4
	};

	for (const [word, idx] of Object.entries(ordinals)) {
		if (new RegExp(`\\b${word}\\b`, "i").test(raw)) return idx;
	}

	return -1;
}

function normalizeLinkList(items) {
	return (Array.isArray(items) ? items : [])
		.map(item => ({ text: normalize(item?.text), href: normalize(item?.href) }))
		.filter(item => item.href && /^https?:\/\//i.test(item.href));
}

function tokenizeMeaningful(text) {
	const stop = new Set([
		"open", "click", "press", "tap", "go", "to", "visit", "navigate", "launch",
		"the", "a", "an", "this", "that", "on", "in", "please", "pls", "plz",
		"link", "button", "tab", "item", "page", "website", "site", "url",
		"can", "you", "for", "me", "now", "it", "one"
	]);

	return normalize(text)
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.filter(token => token.length >= 2 && !stop.has(token));
}

function scoreTextMatch(tokens, candidate) {
	if (!Array.isArray(tokens) || tokens.length === 0) return 0;
	const hay = normalize(candidate).toLowerCase();
	if (!hay) return 0;

	let hits = 0;
	for (const token of tokens) {
		if (hay.includes(token)) hits++;
	}

	return hits;
}

function isMediaLikeUrl(href) {
	const raw = normalize(href).toLowerCase();
	if (!raw) return false;
	if (/\/(file|image):/i.test(raw)) return true;
	if (/\.(jpg|jpeg|png|gif|webp|svg|mp4|webm)(\?|$)/i.test(raw)) return true;
	if (/\/wiki\/file:/i.test(raw)) return true;
	return false;
}

function wantsMediaResult(text) {
	const raw = normalize(text).toLowerCase();
	return /\b(image|photo|picture|file|jpg|jpeg|png|video|gif)\b/.test(raw);
}

function cleanElementTarget(target) {
	return normalize(target)
		.replace(/\b(the|a|an|please|pls|plz)\b/gi, " ")
		.replace(/\b(button|link|tab|item)\b/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeTypedText(value) {
	let text = String(value || "");
	if (!text) return "";

	let removeSpaces = false;
	if (/\bwith\s+no\s+spaces\b/i.test(text) || /\bno\s+spaces\b/i.test(text)) {
		removeSpaces = true;
		text = text.replace(/\bwith\s+no\s+spaces\b/gi, " ").replace(/\bno\s+spaces\b/gi, " ");
	}

	let uppercaseChars = [];
	const capsMatch = text.match(/\bwith\s+([a-z](?:\s+and\s+[a-z])*)\s+capital\b/i);
	if (capsMatch) {
		uppercaseChars = String(capsMatch[1] || "")
			.toLowerCase()
			.split(/\s+and\s+/)
			.map(s => s.trim())
			.filter(Boolean);
		text = text.replace(capsMatch[0], " ");
	}

	text = text
		.replace(/\bunderscore\b/gi, "_")
		.replace(/\bdot\b/gi, ".")
		.replace(/\bat\s+the\s+rate\b/gi, "@")
		.replace(/\bat\b/gi, "@")
		.replace(/\bdash\b|\bhyphen\b/gi, "-")
		.replace(/\bdollar\b/gi, "$")
		.replace(/\s+/g, " ")
		.trim();

	if (uppercaseChars.length > 0) {
		for (const ch of uppercaseChars) {
			if (!/^[a-z]$/.test(ch)) continue;
			const re = new RegExp(ch, "g");
			text = text.replace(re, ch.toUpperCase());
		}
	}

	if (removeSpaces) {
		text = text.replace(/\s+/g, "");
	}

	return text;
}

function looksLikeFieldTarget(target) {
	const raw = normalize(target).toLowerCase();
	if (!raw) return false;
	return /\b(password|username|user name|email|mail|phone|number|search|query|name|login|otp|code|pin)\b|searchbox|textbox|inputbox|passwordbox|usernamebox|emailbox/.test(raw);
}

function isGenericButtonTarget(target) {
	const raw = normalize(target).toLowerCase();
	if (!raw) return true;
	return /^(the\s+)?(button|btn|submit\s+button|ok\s+button|continue\s+button)$/.test(raw);
}

class BrowserPlugin {
	constructor(headless, user_data_dir, firefox_executable_path, obj) {
		this.headless = parseBoolean(headless, false);
		this.userDataDir = normalize(user_data_dir);
		this.firefoxExecutablePath = normalize(firefox_executable_path);
		this.obj = obj;
	}

	async ensureReady() {
		const needsDifferentConfig = Boolean(shared.controller) && (
			normalize(shared.controller?.options?.userDataDir) !== this.userDataDir ||
			normalize(shared.controller?.options?.executablePath) !== this.firefoxExecutablePath
		);

		if (needsDifferentConfig) {
			await shared.controller.close();
			shared.controller = null;
			shared.initialized = false;
		}

		if (!shared.controller) {
			shared.controller = new BrowserController({
				userDataDir: this.userDataDir,
				executablePath: this.firefoxExecutablePath
			});
		}

		if (!shared.initialized) {
			await shared.controller.init(this.headless);
			shared.initialized = true;
			shared.headless = this.headless;
			return;
		}

		try {
			await shared.controller.ensurePage();
		} catch (_) {
			await shared.controller.close();
			await shared.controller.init(this.headless);
			shared.initialized = true;
			shared.headless = this.headless;
			return;
		}

		if (shared.headless !== this.headless) {
			await shared.controller.close();
			await shared.controller.init(this.headless);
			shared.headless = this.headless;
		}
	}

	async _currentPage() {
		await this.ensureReady();
		return shared.controller.page;
	}

	async _open(url) {
		let safeUrl = toSafeUrl(url);
		if (!safeUrl) {
			const resolved = await this._resolveDomainFromBrand(url);
			if (resolved) {
				safeUrl = toSafeUrl(resolved);
			}
		}

		if (!safeUrl) {
			return {
				status: "needs_input",
				field: "url",
				message: "Please provide a valid URL or a recognizable website/brand name (for example: wikipedia, youtube.com)."
			};
		}

		await this.ensureReady();
		await shared.controller.openPage(safeUrl);
		shared.lastOpenedUrl = safeUrl;
		const title = await shared.controller.getTitle();
		return `Opened ${safeUrl}. Current page title: ${title}`;
	}

	async _resolveDomainFromBrand(rawTarget) {
		const target = cleanOpenTarget(rawTarget);
		if (!target) return "";
		if (/\s/.test(target) && target.split(/\s+/).length > 8) return "";

		const clientId = String(process.env.bfcid || "").trim();
		if (!clientId) return "";

		const url = `https://api.brandfetch.io/v2/search/${encodeURIComponent(target)}?c=${encodeURIComponent(clientId)}`;
		try {
			const res = await fetch(url, { method: "GET" });
			if (!res.ok) return "";
			const data = await res.json();
			const items = Array.isArray(data) ? data : [];
			if (!items.length) return "";

			const query = normalize(target).toLowerCase();
			const scoreItem = (item) => {
				const domain = normalize(item?.domain).toLowerCase();
				const name = normalize(item?.name).toLowerCase();
				const quality = Number(item?.qualityScore || 0);
				const verifiedBoost = item?.verified ? 1 : 0;
				const exactName = name && name === query ? 2 : 0;
				const includesQuery = (domain.includes(query) || name.includes(query)) ? 1 : 0;
				const rawScore = Number(item?._score || 0) / 100;
				return (quality * 3) + verifiedBoost + exactName + includesQuery + rawScore;
			};

			items.sort((a, b) => scoreItem(b) - scoreItem(a));
			const best = items[0];
			const bestDomain = normalize(best?.domain);
			if (!bestDomain || !bestDomain.includes(".")) return "";
			return bestDomain;
		} catch (_) {
			return "";
		}
	}

	async _scroll(amount, direction = "down") {
		await this.ensureReady();
		const value = Number(amount);
		const base = Number.isFinite(value) ? Math.abs(value) : 500;
		const dir = normalize(direction).toLowerCase();
		const dy = dir === "up" ? -base : base;
		await shared.controller.scroll(dy);
		return `Scrolled ${dir === "up" ? "up" : "down"} by ${Math.abs(dy)} pixels.`;
	}

	async _resolveUrlFromCurrentContext(inputText = "") {
		const raw = normalize(inputText).toLowerCase();
		if (!raw) return "";

		const asksForLink = /\b(link|url|post|article|reel|video|source|one)\b/.test(raw);
		if (!asksForLink) return "";

		// Referential target like "that" or "this link" -> check central message history
		if (isReferentialOpenTarget(raw)) {
			try {
				const globalWithLink = messageHistory.getLatestGlobal(m => Array.isArray(m.links) && m.links.length > 0);
				if (globalWithLink && Array.isArray(globalWithLink.links) && globalWithLink.links.length > 0) {
					return globalWithLink.links[globalWithLink.links.length - 1];
				}
			} catch (_) {}
			return "";
		}

		// Explicit recent email link request
		if (/\b(latest|most recent)\b/.test(raw) && /\b(email|mail)\b/.test(raw)) {
			try {
				const gmailLink = messageHistory.getLastLinkForSource('gmail');
				if (gmailLink && gmailLink.link) return gmailLink.link;
			} catch (_) {}
		}

		let liveLinks = [];
		try {
			if (shared.controller || shared.initialized) {
				await this.ensureReady();
				liveLinks = normalizeLinkList(await shared.controller.getPageLinks());
			}
		} catch (_) {
			liveLinks = [];
		}

		const links = liveLinks.length
			? liveLinks
			: normalizeLinkList(shared.lastSeen?.links || []);

		if (!links.length) return "";

		const idx = getOrdinalIndex(raw);
		if (idx >= 0 && links[idx]) {
			return links[idx].href;
		}

		if (/\b(other|another|next|different)\b/.test(raw) && shared.lastOpenedUrl) {
			const alt = links.find(item => item.href !== shared.lastOpenedUrl);
			if (alt) return alt.href;
		}

		if (/\b(insta|instagram|reel|ig)\b/.test(raw)) {
			const hit = links.find(item => /instagram/i.test(item.href));
			if (hit) return hit.href;
		}

		if (/\b(facebook|fb)\b/.test(raw)) {
			const hit = links.find(item => /facebook|fb\.com/i.test(item.href));
			if (hit) return hit.href;
		}

		if (/\b(youtube|yt|video)\b/.test(raw)) {
			const hit = links.find(item => /youtube|youtu\.be/i.test(item.href));
			if (hit) return hit.href;
		}

		const tokens = tokenizeMeaningful(raw);
		if (tokens.length === 0) {
			return links[0]?.href || "";
		}

		let best = null;
		let bestScore = 0;
		const allowMedia = wantsMediaResult(raw);
		for (const item of links) {
			const href = normalize(item.href).toLowerCase();
			const text = normalize(item.text).toLowerCase();
			const textScore = scoreTextMatch(tokens, text);
			const hrefScore = scoreTextMatch(tokens, href);
			let score = (textScore * 3) + hrefScore;
			const joined = `${text} ${href}`;
			const queryPhrase = tokens.join(" ").trim();

			if (queryPhrase && joined.includes(queryPhrase)) {
				score += 3;
			}

			if (!allowMedia && isMediaLikeUrl(href)) {
				score -= 3;
			}

			if (/\/wiki\//.test(href) && !/\/wiki\/(file|special):/i.test(href)) {
				score += 1;
			}

			if (/createaccount|login|signin|special:|donate|account|userlogin/i.test(href)) {
				score -= 4;
			}

			if (score > bestScore) {
				bestScore = score;
				best = item;
			}
		}

		// Require a reasonable match to avoid opening random first links.
		if (!best || bestScore < Math.min(3, Math.max(2, tokens.length))) {
			return "";
		}

		return best.href || "";
	}

	async _close() {
		if (!shared.controller) {
			return "Browser is already closed.";
		}

		await shared.controller.close();
		shared.initialized = false;
		shared.pending = null;
		return "Browser closed successfully.";
	}

	async _back() {
		await this.ensureReady();
		const result = await shared.controller.goBack();
		if (!result?.ok) {
			return "I could not go back because there is no previous page in this tab history.";
		}
		return `Went back. Current page: ${result.url}`;
	}

	async _type(target, text, submit = false) {
		await this.ensureReady();
		const page = await this._currentPage();
		const targetValue = normalize(target);
		const textValue = normalizeTypedText(text);
		if (!textValue) {
			return {
				status: "needs_input",
				field: "text",
				message: "Please provide text to type."
			};
		}

		if (!targetValue) {
			const activeIsText = await page.evaluate(() => {
				const el = document.activeElement;
				if (!el) return false;
				const tag = String(el.tagName || "").toLowerCase();
				return tag === "input" || tag === "textarea" || Boolean(el.isContentEditable);
			});

			if (activeIsText) {
				await page.keyboard.press("Control+A").catch(() => {});
				await page.keyboard.press("Backspace").catch(() => {});
				await page.keyboard.type(textValue);
				if (submit) {
					await page.keyboard.press("Enter");
				}
				return submit
					? "Typed into the active field and submitted."
					: "Typed into the active field.";
			}

			const fallbackSelectors = [
				"input[aria-label*='Search' i]",
				"input[type='search']",
				"input[type='text']",
				"textarea",
				"input"
			];

			for (const selector of fallbackSelectors) {
				const loc = page.locator(selector);
				const count = await loc.count();
				for (let i = 0; i < Math.min(count, 5); i++) {
					const field = loc.nth(i);
					if (!(await field.isVisible().catch(() => false))) continue;
					await field.click().catch(() => {});
					await field.fill(textValue).catch(async () => {
						await page.keyboard.type(textValue);
					});
					if (submit) {
						await field.press("Enter").catch(async () => {
							await page.keyboard.press("Enter");
						});
					}
					return submit
						? "Typed into a visible field and submitted."
						: "Typed into a visible field.";
				}
			}

			return {
				status: "needs_input",
				field: "target",
				message: "I could not find a text field automatically. Please specify where to type, for example: type devilbehindya_911 into input[aria-label=\"Search\"]."
			};
		}

		if (isLikelySelector(targetValue)) {
			await shared.controller.type(targetValue, textValue);
			if (submit) {
				await page.locator(targetValue).press("Enter");
			}
			return submit
				? `Typed into ${targetValue} and submitted.`
				: `Typed into ${targetValue}.`;
		}

		const byLabel = page.getByLabel(targetValue, { exact: false });
		if (await byLabel.count()) {
			await byLabel.first().fill(textValue);
			if (submit) await byLabel.first().press("Enter");
			return submit
				? `Typed into field labeled \"${targetValue}\" and submitted.`
				: `Typed into field labeled \"${targetValue}\".`;
		}

		const byPlaceholder = page.getByPlaceholder(targetValue, { exact: false });
		if (await byPlaceholder.count()) {
			await byPlaceholder.first().fill(textValue);
			if (submit) await byPlaceholder.first().press("Enter");
			return submit
				? `Typed into placeholder \"${targetValue}\" and submitted.`
				: `Typed into placeholder \"${targetValue}\".`;
		}

		return {
			status: "needs_input",
			field: "target",
			message: `I could not find a textbox for \"${targetValue}\". Please provide a CSS selector like #search or input[name=\"q\"].`
		};
	}

	async _focus(target) {
		await this.ensureReady();
		const page = await this._currentPage();
		const targetValue = normalize(target);
		if (!targetValue) {
			return {
				status: "needs_input",
				field: "target",
				message: "Please tell me which field to focus, for example password or username."
			};
		}

		if (isLikelySelector(targetValue)) {
			const loc = page.locator(targetValue).first();
			if (await loc.count()) {
				await loc.click();
				return `Focused ${targetValue}.`;
			}
		}

		const lowered = targetValue.toLowerCase();
		if (/password/.test(lowered)) {
			const pwd = page.locator("input[type='password']");
			if (await pwd.count()) {
				await pwd.first().click();
				return "Focused the password field.";
			}
		}

		const byLabel = page.getByLabel(targetValue, { exact: false });
		if (await byLabel.count()) {
			await byLabel.first().click();
			return `Focused field labeled \"${targetValue}\".`;
		}

		const byPlaceholder = page.getByPlaceholder(targetValue, { exact: false });
		if (await byPlaceholder.count()) {
			await byPlaceholder.first().click();
			return `Focused field with placeholder \"${targetValue}\".`;
		}

		const candidates = page.locator("input, textarea, [contenteditable='true']");
		const count = await candidates.count();
		for (let i = 0; i < Math.min(count, 8); i++) {
			const field = candidates.nth(i);
			const attrs = await field.evaluate(el => ({
				name: (el.getAttribute("name") || "").toLowerCase(),
				id: (el.getAttribute("id") || "").toLowerCase(),
				placeholder: (el.getAttribute("placeholder") || "").toLowerCase(),
				aria: (el.getAttribute("aria-label") || "").toLowerCase()
			})).catch(() => null);
			if (!attrs) continue;
			const hay = `${attrs.name} ${attrs.id} ${attrs.placeholder} ${attrs.aria}`;
			if (hay.includes(lowered)) {
				await field.click();
				return `Focused the ${targetValue} field.`;
			}
		}

		return {
			status: "needs_input",
			field: "target",
			message: `I could not find a field matching \"${targetValue}\". Please provide a selector, for example input[type=\"password\"].`
		};
	}

	async _findClickCandidates(text, kind = "any") {
		const page = await this._currentPage();
		const query = normalize(text);
		const out = [];

		if (!query) return out;

		const pushCandidates = async (selector, type) => {
			const loc = page.locator(selector, { hasText: query });
			const count = Math.min(await loc.count(), 5);
			for (let i = 0; i < count; i++) {
				const node = loc.nth(i);
				const inner = normalize(await node.innerText().catch(() => ""));
				out.push({
					type,
					text: inner || query,
					selector: selector
				});
			}
		};

		if (kind === "any" || kind === "link") {
			await pushCandidates("a", "link");
		}

		if (kind === "any" || kind === "button") {
			await pushCandidates("button", "button");
			await pushCandidates("input[type=submit]", "button");
			await pushCandidates("input[type=button]", "button");
		}

		return out;
	}

	async _click(target, type = "any", disambiguationInput = "") {
		await this.ensureReady();
		const page = await this._currentPage();
		const targetValue = normalize(target);
		const cleanedTarget = cleanElementTarget(targetValue) || targetValue;
		const clickType = normalize(type).toLowerCase();

		if ((clickType === "button" || /\bbutton\b/i.test(targetValue)) && isGenericButtonTarget(targetValue)) {
			const button = page.locator("button, input[type=submit], input[type=button]").first();
			if (await button.count()) {
				await button.click();
				return "Clicked the first visible button.";
			}
		}

		if (looksLikeFieldTarget(cleanedTarget)) {
			const focused = await this._focus(cleanedTarget);
			if (typeof focused === "string") {
				return focused;
			}
		}

		if (!targetValue) {
			return {
				status: "needs_input",
				field: "target",
				message: "Please provide what you want to click (selector, link text, or button text)."
			};
		}

		if (shared.pending && shared.pending.action === "click") {
			const picked = pickByIndex(disambiguationInput, shared.pending.candidates);
			if (!picked) {
				return {
					status: "needs_input",
					field: "target",
					message: `Please choose a click target by number. Options: ${summarizeCandidates(shared.pending.candidates)}`
				};
			}

			await page.locator(picked.selector, { hasText: picked.text }).first().click();
			shared.pending = null;
			return `Clicked ${picked.type} \"${picked.text}\".`;
		}

		if (isLikelySelector(targetValue)) {
			await shared.controller.click(targetValue);
			return `Clicked ${targetValue}.`;
		}

		const candidates = await this._findClickCandidates(
			cleanedTarget,
			clickType === "link" || clickType === "button" ? clickType : "any"
		);

		if (candidates.length === 0) {
			return {
				status: "needs_input",
				field: "target",
				message: `Could not find a clickable element matching \"${targetValue}\". Try giving a CSS selector.`
			};
		}

		if (candidates.length > 1) {
			shared.pending = {
				action: "click",
				candidates,
				createdAt: Date.now()
			};

			return {
				status: "needs_input",
				field: "target",
				message: `I found multiple matches. Choose option number: ${summarizeCandidates(candidates)}`
			};
		}

		const only = candidates[0];
		await page.locator(only.selector, { hasText: only.text }).first().click();
		return `Clicked ${only.type} \"${only.text}\".`;
	}

	async _submit(target) {
		await this.ensureReady();
		const page = await this._currentPage();
		const targetValue = normalize(target);

		if (!targetValue) {
			const activeIsText = await page.evaluate(() => {
				const el = document.activeElement;
				if (!el) return false;
				const tag = String(el.tagName || "").toLowerCase();
				return tag === "input" || tag === "textarea" || Boolean(el.isContentEditable);
			});

			if (activeIsText) {
				await page.keyboard.press("Enter").catch(() => {});
				return "Pressed Enter on the active field.";
			}
		}

		if (targetValue && isLikelySelector(targetValue)) {
			await page.locator(targetValue).first().press("Enter");
			return `Submitted using ${targetValue}.`;
		}

		if (targetValue) {
			const res = await this._click(targetValue, "button");
			if (typeof res === "string") return `Submitted form by clicking ${targetValue}.`;
			return res;
		}

		const submitButton = page.locator("button[type=submit], input[type=submit]");
		if (await submitButton.count()) {
			await submitButton.first().click();
			return "Submitted the form using the submit button.";
		}

		return {
			status: "needs_input",
			field: "target",
			message: "I could not find a submit button. Provide a selector for the submit element."
		};
	}

	async _parseAction(input) {
		const text = normalize(input);
		if (!text) return { action: "unknown" };
		const hasOpenVerb = /\b(open|go to|visit|navigate to|launch)\b/i.test(text);

		const fieldNavMatch = text.match(/^(?:go to|goto|move to|switch to)\s+([\s\S]+)$/i);
		if (fieldNavMatch && fieldNavMatch[1]) {
			const fieldTarget = cleanElementTarget(fieldNavMatch[1]) || normalize(fieldNavMatch[1]);
			if (looksLikeFieldTarget(fieldTarget)) {
				return { action: "focus", target: fieldTarget };
			}
		}

		const openMatch = text.match(/(?:open|go to|visit|navigate to)\s+([\w.-]+\.[a-z]{2,}(?:\/\S*)?|https?:\/\/\S+)/i);
		if (openMatch) {
			return { action: "open", url: normalize(openMatch[1]) };
		}

		if (hasOpenVerb) {
			const genericOpen = text.match(/(?:open|go to|visit|navigate to|launch)\s+([\s\S]+)/i);
			if (genericOpen && genericOpen[1]) {
				const target = cleanOpenTarget(genericOpen[1]);
				if (looksLikeFieldTarget(target)) {
					return { action: "focus", target };
				}
				if (target && !isReferentialOpenTarget(target)) {
					return { action: "open", url: target };
				}
			}

			const fromLastResponse = extractFirstUrl(this.obj?.lastAssistantResponse || global.__btwLastAssistantResponse || "");
			if (fromLastResponse) {
				return { action: "open", url: fromLastResponse };
			}

			let fromContext = "";
			try {
				fromContext = await this._resolveUrlFromCurrentContext(text);
			} catch (_) {
				fromContext = "";
			}
			if (fromContext) {
				return { action: "open", url: fromContext };
			}

			return { action: "open", url: null };
		}

		if (/^(?:press\s+)?(?:enter|return)(?:\s*\/\s*(?:enter|return))?$/.test(text.toLowerCase())) {
			return { action: "submit", target: null };
		}

		if (/^(?:press|click)(?:\s+on)?\s+search$/.test(text.toLowerCase())) {
			return { action: "submit", target: "search" };
		}

		const clickMatch = text.match(/(?:c?click|press|tap)\s+(?:on\s+)?(.+)/i);
		if (clickMatch) {
			return { action: "click", target: normalize(clickMatch[1]), element_type: /\blink\b/i.test(text) ? "link" : (/\bbutton\b/i.test(text) ? "button" : "any") };
		}

		const typeMatch = text.match(/(?:type|enter|fill)\s+([\s\S]+?)\s+(?:into|in|inside)\s+([\s\S]+)/i);
		if (typeMatch) {
			return { action: "type", text: normalize(typeMatch[1]), target: normalize(typeMatch[2]), submit: /\bsubmit\b|\benter\b/i.test(text) };
		}

		const focusMatch = text.match(/^(?:select|focus|choose)\s+(?:on\s+)?([\s\S]+)$/i);
		if (focusMatch) {
			return { action: "focus", target: cleanElementTarget(focusMatch[1]) || normalize(focusMatch[1]) };
		}

		const typeOnlyMatch = text.match(/^(?:type|enter|fill)\s+(?:in\s+)?([\s\S]+)$/i);
		if (typeOnlyMatch) {
			return { action: "type", text: normalize(typeOnlyMatch[1]), target: null, submit: false };
		}

		const submitTextMatch = text.match(/^(?:submit|search)\s+([\s\S]+)$/i);
		if (submitTextMatch) {
			return { action: "type", text: normalize(submitTextMatch[1]), target: null, submit: true };
		}

		if (/\bsubmit\b/.test(text)) {
			return { action: "submit" };
		}

		if (/\bscroll\b/.test(text)) {
			const amt = text.match(/(-?\d{1,5})/);
			const direction = /\bup\b|\btop\b/.test(text.toLowerCase()) ? "up" : "down";
			return { action: "scroll", amount: amt ? Number(amt[1]) : 500, direction };
		}

		if (/\b(go back|back|previous page|previous)\b/i.test(text)) {
			return { action: "back" };
		}

		if (/\b(close|exit|quit|shutdown|stop)\b/.test(text) && /\b(browser|tab|window)\b/.test(text)) {
			return { action: "close" };
		}

		if (!hasOpenVerb && /\blinks?\b|\bbuttons?\b|\binputs?\b|\belements?\b/.test(text)) {
			return { action: "inspect" };
		}

		if (typeof this.obj?.customQuery === "function") {
			const prompt =
`Extract browser control intent as JSON only.
Schema:
{
	"action":"open|click|type|submit|back|close|scroll|inspect|unknown",
	"url":"string|null",
	"target":"string|null",
	"text":"string|null",
	"element_type":"link|button|any|null",
	"amount": number|null,
	"direction":"up|down|null",
	"submit": boolean|null
}
User input: ${JSON.stringify(text)}`;

			try {
				const raw = await this.obj.customQuery(prompt);
				const match = String(raw || "").match(/\{[\s\S]*\}/);
				if (match) {
					const parsed = JSON.parse(match[0]);
					return parsed;
				}
			} catch (_) {
			}
		}

		return { action: "unknown" };
	}

	async prefillWorkflowParams({ workflow, input, params }) {
		const text = normalize(input);
		if (!text) return {};

		if (workflow === "browser_action") {
			const parsed = await this._parseAction(text);
			const next = {};
			if (!params?.action && parsed.action && parsed.action !== "unknown") next.action = parsed.action;
			if (!params?.url && parsed.url) next.url = parsed.url;
			if (!params?.target && parsed.target) next.target = parsed.target;
			if (!params?.text && parsed.text) next.text = parsed.text;
			if (!params?.element_type && parsed.element_type) next.element_type = parsed.element_type;
			if (params?.amount === undefined && parsed.amount !== null && parsed.amount !== undefined) next.amount = parsed.amount;
			if (!params?.direction && parsed.direction) next.direction = parsed.direction;
			if (params?.submit === undefined && parsed.submit !== null && parsed.submit !== undefined) next.submit = parsed.submit;
			return next;
		}

		return {};
	}

	async executeBrowserWorkflow(params, context = {}) {
		const action = normalize(params.action).toLowerCase();

		if (!action) {
			return {
				status: "needs_input",
				field: "action",
				message: "Please tell me the browser action: open, click, type, focus, submit, back, close, scroll, or inspect."
			};
		}

		if (action === "open") {
			if (!normalize(params.url)) {
				return { status: "needs_input", field: "url", message: "Please provide the website URL to open." };
			}
			return await this._open(params.url);
		}

		if (action === "click") {
			return await this._click(params.target, params.element_type, context.input || "");
		}

		if (action === "type") {
			return await this._type(params.target, params.text, parseBoolean(params.submit, false));
		}

		if (action === "focus") {
			return await this._focus(params.target);
		}

		if (action === "submit") {
			return await this._submit(params.target);
		}

		if (action === "back") {
			return await this._back();
		}

		if (action === "close") {
			return await this._close();
		}

		if (action === "scroll") {
			return await this._scroll(params.amount, params.direction);
		}

		if (action === "inspect") {
			return await this.getPageElements(context.input || "");
		}

		return {
			status: "needs_input",
			field: "action",
			message: "Unsupported browser action. Use open, click, type, focus, submit, back, close, scroll, or inspect."
		};
	}

	async controlBrowser(input) {
		const parsed = await this._parseAction(input);
		const result = await this.executeBrowserWorkflow({
			action: parsed.action,
			url: parsed.url,
			target: parsed.target,
			text: parsed.text,
			element_type: parsed.element_type,
			amount: parsed.amount,
			direction: parsed.direction,
			submit: parsed.submit
		}, {
			input
		});

		if (result && typeof result === "object" && result.status === "needs_input") {
			return String(result.message || "Please provide more details.");
		}

		return result;
	}

	async getPageElements() {
		await this.ensureReady();
		const page = await this._currentPage();
		const url = page.url();
		const title = await page.title();

		const links = await shared.controller.getPageLinks();
		const buttons = await shared.controller.getPageButtons();
		const inputs = await page.$$eval("input, textarea", nodes =>
			nodes.slice(0, 20).map(n => ({
				name: n.getAttribute("name") || "",
				id: n.getAttribute("id") || "",
				placeholder: n.getAttribute("placeholder") || "",
				type: n.getAttribute("type") || "text"
			}))
		);

		const elements = {
			url,
			title,
			links: links.slice(0, 30),
			buttons: buttons.slice(0, 30),
			inputs
		};

		this._updateLastSeen(elements);
		return elements;
	}

	_updateLastSeen(elements) {
		shared.lastSeen = {
			url: elements?.url || "",
			title: elements?.title || "",
			links: Array.isArray(elements?.links) ? elements.links.slice(0, 40) : [],
			buttons: Array.isArray(elements?.buttons) ? elements.buttons.slice(0, 40) : [],
			inputs: Array.isArray(elements?.inputs) ? elements.inputs.slice(0, 40) : []
		};
	}

	async getBrowserStatus() {
		await this.ensureReady();
		const page = await this._currentPage();
		return {
			initialized: shared.initialized,
			headless: shared.headless,
			current_url: page.url(),
			title: await page.title()
		};
	}

	async handleFollowUp(input) {
		if (!shared.pending || shared.pending.action !== "click") {
			return { handled: false };
		}

		if (Date.now() - Number(shared.pending.createdAt || 0) > 10 * 60 * 1000) {
			shared.pending = null;
			return { handled: false };
		}

		const picked = pickByIndex(input, shared.pending.candidates || []);
		if (!picked) {
			return { handled: false };
		}

		await this.ensureReady();
		const page = await this._currentPage();
		await page.locator(picked.selector, { hasText: picked.text }).first().click();
		shared.pending = null;
		return {
			handled: true,
			response: `Clicked ${picked.type} \"${picked.text}\".`
		};
	}
}

module.exports = BrowserPlugin;
