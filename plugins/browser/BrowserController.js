const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

class BrowserController {
  constructor(options = {}) {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.options = {
      userDataDir: String(options.userDataDir || "").trim(),
      executablePath: String(options.executablePath || "").trim()
    };
  }

  getFallbackProfileDir() {
    return path.join(os.homedir(), ".config/BraveSoftware/Brave-Browser");
  }

  isProfileLockError(err) {
    const msg = String(err?.message || err || "").toLowerCase();
    return (
      msg.includes("chrome is already running") ||
      msg.includes("profile") && msg.includes("lock") ||
      msg.includes("in use")
    );
  }

  getBraveProfileDir() {
    const braveConfigDir = path.join(os.homedir(), ".config/BraveSoftware/Brave-Browser");
    if (fs.existsSync(braveConfigDir)) {
      return braveConfigDir;
    }
    return braveConfigDir;
  }

  getSystemBraveExecutablePath() {
    const candidates = [
      process.env.BRAVE_BIN,
      "/usr/bin/brave",
      "/usr/bin/brave-browser",
      "/snap/bin/brave"
    ].filter(Boolean);

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch (_) {
      }
    }

    return "";
  }

  getResolvedProfileDir() {
    const requested = String(this.options.userDataDir || "").trim();
    if (requested && fs.existsSync(requested)) {
      return requested;
    }
    return this.getBraveProfileDir();
  }

  getResolvedExecutablePath() {
    const requested = String(this.options.executablePath || "").trim();
    if (requested && fs.existsSync(requested)) {
      return requested;
    }
    return this.getSystemBraveExecutablePath() || "";
  }

  // Initialize browser
  async init(headless = false) {
    const profileDir = this.getResolvedProfileDir();
    const executablePath = this.getResolvedExecutablePath();

    const launchOpts = {
      headless,
      args: [
        "--disable-blink-features=AutomationControlled"
      ]
    };

    if (executablePath) {
      launchOpts.executablePath = executablePath;
    }

    try {
      this.context = await chromium.launchPersistentContext(profileDir, launchOpts);
      this.activeUserDataDir = profileDir;
    } catch (err) {
      const fallbackDir = this.getFallbackProfileDir();
      const canRetryWithFallback = this.isProfileLockError(err) && profileDir !== fallbackDir;
      if (!canRetryWithFallback) {
        throw err;
      }

      this.context = await chromium.launchPersistentContext(fallbackDir, launchOpts);
      this.activeUserDataDir = fallbackDir;
    }

    const existingPages = this.context.pages();
    this.page = existingPages[0] || await this.context.newPage();
  }

  async ensurePage() {
    if (!this.context) {
      throw new Error("Browser not initialized. Call init()");
    }

    let pages;
    try {
      pages = this.context.pages();
    } catch (_) {
      throw new Error("Browser context is closed. Reinitialize browser.");
    }

    if (this.page && typeof this.page.isClosed === "function" && this.page.isClosed()) {
      this.page = null;
    }

    if (!this.page) {
      this.page = pages[0] || await this.context.newPage();
    }

    return this.page;
  }

  // Open URL
  async openPage(url) {
    const activePage = await this.ensurePage();

    // If popups or extra tabs were left open, keep a single active tab.
    const pages = this.context ? this.context.pages() : [];
    if (pages.length > 1) {
      for (const p of pages) {
        if (p !== activePage) {
          await p.close().catch(() => {});
        }
      }
    }

    await activePage.goto(url.startsWith('http') ? url : `https://${url}`);
    this.page = activePage;
  }

  // Scroll
  async scroll(amount = 500) {
    const page = await this.ensurePage();
    await page.mouse.wheel(0, amount);
  }

  // Navigate back in history
  async goBack() {
    const page = await this.ensurePage();
    const resp = await page.goBack().catch(() => null);
    return {
      ok: Boolean(resp),
      url: page.url()
    };
  }

  // Click element
  async click(selector) {
    const page = await this.ensurePage();
    await page.click(selector);
  }

  // Type into input
  async type(selector, text) {
    const page = await this.ensurePage();
    await page.fill(selector, text);
  }

  // Get all links
  async getPageLinks() {
    const page = await this.ensurePage();
    return await page.$$eval('a', links =>
      links.map(link => ({
        text: link.innerText.trim(),
        href: link.href
      }))
    );
  }

  // Get all buttons
  async getPageButtons() {
    const page = await this.ensurePage();
    return await page.$$eval('button', buttons =>
      buttons.map(btn => ({
        text: btn.innerText.trim()
      }))
    );
  }

  // Open link in new tab
  async openLinkInNewTab(url) {
    await this.ensurePage();
    const newPage = await this.context.newPage();
    await newPage.goto(url);
    return newPage;
  }

  // Get title
  async getTitle() {
    const page = await this.ensurePage();
    return await page.title();
  }

  // Close browser
  async close() {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

module.exports = BrowserController;