import { test as base, chromium, type BrowserContext, type Page } from "@playwright/test";
import path from "path";
import http from "http";
import fs from "fs";

const EXTENSION_SRC = path.resolve(__dirname, "../LeadMomentum-Chrome");
const FIXTURES_DIR = path.resolve(__dirname, "fixtures");
const TEST_EXT_DIR = path.resolve(__dirname, "../test-extension");

/**
 * Build a test copy of the extension with expanded permissions.
 * activeTab only grants access on user gesture (clicking the icon),
 * which can't be simulated in Playwright. The test copy adds "tabs"
 * and "<all_urls>" so content script injection works programmatically.
 */
function buildTestExtension(): string {
  if (fs.existsSync(TEST_EXT_DIR)) {
    fs.rmSync(TEST_EXT_DIR, { recursive: true });
  }
  fs.cpSync(EXTENSION_SRC, TEST_EXT_DIR, { recursive: true });

  const manifestPath = path.join(TEST_EXT_DIR, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

  // Add "tabs" so chrome.tabs.query returns URLs
  if (!manifest.permissions.includes("tabs")) {
    manifest.permissions.push("tabs");
  }
  // Add <all_urls> so scripting.executeScript works on any page
  if (!manifest.host_permissions.includes("<all_urls>")) {
    manifest.host_permissions.push("<all_urls>");
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return TEST_EXT_DIR;
}

const EXTENSION_PATH = buildTestExtension();

/**
 * Simple HTTP server for serving test fixture HTML files.
 * Extensions can inject content scripts into http:// pages but not file:// pages.
 */
// Allowlist of fixture files — only these can be served
const ALLOWED_FIXTURES: Record<string, string> = {};
for (const file of fs.readdirSync(FIXTURES_DIR)) {
  ALLOWED_FIXTURES["/" + file] = path.join(FIXTURES_DIR, file);
}

function startFixtureServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const filePath = ALLOWED_FIXTURES[req.url || ""];
      if (!filePath) { res.writeHead(404); res.end("Not found"); return; }
      const ext = path.extname(filePath);
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
      };
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": mime[ext] || "text/plain" });
      res.end(content);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

/**
 * Custom Playwright fixture that launches Chromium with the LeadMomentum
 * extension loaded via a persistent context (required for MV3 extensions).
 */
export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  popupPage: Page;
  fixtureBaseUrl: string;
}>({
  // Local HTTP server for fixture files
  fixtureBaseUrl: [async ({}, use) => {
    const server = await startFixtureServer();
    const addr = server.address() as { port: number };
    await use(`http://127.0.0.1:${addr.port}`);
    server.close();
  }, { scope: "test" }],

  // Override context to use a persistent context with the extension loaded
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    await use(context);
    await context.close();
  },

  // Resolve the extension ID from the service worker
  extensionId: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background) {
      background = await context.waitForEvent("serviceworker");
    }
    const extensionId = background.url().split("/")[2];
    await use(extensionId);
  },

  // Open the popup page (plain, no tab target — for popup-only tests)
  popupPage: async ({ context, extensionId }, use) => {
    const popupUrl = `chrome-extension://${extensionId}/popup/index.html`;
    const page = await context.newPage();
    await page.goto(popupUrl);
    await use(page);
    await page.close();
  },
});

export const expect = test.expect;

/**
 * Get the Chrome tab ID for a Playwright page.
 * This is the real Chrome-internal tab ID that the extension APIs use.
 */
export async function getChromeTabId(
  context: BrowserContext,
  extensionId: string,
  pageUrl: string
): Promise<number> {
  // Use a temporary extension page to query chrome.tabs
  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${extensionId}/popup/index.html`);

  const tabId = await helper.evaluate(async (url) => {
    return new Promise<number>((resolve, reject) => {
      chrome.tabs.query({}, (tabs) => {
        const tab = tabs.find((t) => t.url?.includes(url));
        if (tab?.id) resolve(tab.id);
        else reject(new Error("Tab not found for URL: " + url));
      });
    });
  }, pageUrl);

  await helper.close();
  return tabId;
}

/**
 * Open the popup in detached window mode, pointed at a specific tab.
 * This is how the extension actually works: background.js opens
 * popup/index.html?tabId=N&domain=DOMAIN
 */
export async function openPopupForTab(
  context: BrowserContext,
  extensionId: string,
  tabId: number,
  domain: string
): Promise<Page> {
  const url =
    `chrome-extension://${extensionId}/popup/index.html` +
    `?tabId=${tabId}&domain=${encodeURIComponent(domain)}`;
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

/**
 * Read a value from chrome.storage.local via page.evaluate.
 * Must be called on an extension page (popup or background).
 */
export async function getStorageLocal(page: Page, key: string): Promise<any> {
  return page.evaluate(async (k) => {
    return new Promise((resolve) => {
      chrome.storage.local.get([k], (data: Record<string, any>) => {
        resolve(data[k]);
      });
    });
  }, key);
}

/**
 * Set a value in chrome.storage.local via page.evaluate.
 */
export async function setStorageLocal(
  page: Page,
  data: Record<string, any>
): Promise<void> {
  await page.evaluate(async (d) => {
    return new Promise<void>((resolve) => {
      chrome.storage.local.set(d, () => resolve());
    });
  }, data);
}

/**
 * Clear all chrome.storage.local data.
 */
export async function clearStorageLocal(page: Page): Promise<void> {
  await page.evaluate(async () => {
    return new Promise<void>((resolve) => {
      chrome.storage.local.clear(() => resolve());
    });
  });
}
