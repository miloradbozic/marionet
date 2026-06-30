import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium, type Browser, type Page } from "playwright";
import path from "node:path";
import { promises as fs } from "node:fs";

// Never launches its own browser -- always attaches over CDP to a browser the
// human started and authenticated manually. Re-triggering an automated login
// flow is exactly the anti-automation block this is designed to avoid (see
// README "Ground rules").
const CDP_ENDPOINT = process.env.MARIONET_BROWSER_CDP_ENDPOINT ?? "http://localhost:9222";
const WORKSPACE_ROOT = path.resolve(process.cwd(), "workspace");

let browser: Browser | undefined;
let page: Page | undefined;

// Connects lazily, on first browser tool call, so a run that never touches
// the browser doesn't fail just because Chrome isn't running with
// --remote-debugging-port yet.
async function getPage(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  if (!browser || !browser.isConnected()) {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  }
  const context = browser.contexts()[0] ?? (await browser.newContext());
  page = context.pages()[0] ?? (await context.newPage());
  return page;
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const server = new McpServer({ name: "marionet-browser", version: "0.1.0" });

server.registerTool(
  "browser__navigate",
  {
    description: `Navigate the attached browser to a URL. Attaches over CDP to an already-running, manually-authenticated Chrome (${CDP_ENDPOINT}) -- never launches its own browser.`,
    inputSchema: { url: z.string().url() },
  },
  async ({ url }) => {
    try {
      const p = await getPage();
      await p.goto(url, { waitUntil: "domcontentloaded" });
      return { content: [{ type: "text" as const, text: `Navigated to ${p.url()} ("${await p.title()}")` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__click",
  {
    description: "Click an element on the current page identified by a CSS selector.",
    inputSchema: { selector: z.string() },
  },
  async ({ selector }) => {
    try {
      const p = await getPage();
      await p.click(selector, { timeout: 15_000 });
      return { content: [{ type: "text" as const, text: `Clicked ${selector}` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__extract",
  {
    description:
      "Read content from the current page: visible text, raw HTML, or a screenshot. Defaults to the whole page if no selector given.",
    inputSchema: {
      selector: z.string().optional(),
      format: z.enum(["text", "html", "screenshot"]).optional().describe("Default: text"),
    },
  },
  async ({ selector, format }) => {
    try {
      const p = await getPage();
      const fmt = format ?? "text";
      if (fmt === "screenshot") {
        const buffer = selector ? await p.locator(selector).screenshot() : await p.screenshot();
        return { content: [{ type: "image" as const, data: buffer.toString("base64"), mimeType: "image/png" }] };
      }
      const locator = selector ? p.locator(selector) : p.locator("body");
      const text = fmt === "html" ? await locator.innerHTML() : await locator.innerText();
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__download",
  {
    description: "Click an element that triggers a file download, and save the resulting file under workspace/.",
    inputSchema: {
      selector: z.string(),
      savePath: z.string().describe("Destination path, relative to workspace/ unless absolute"),
    },
  },
  async ({ selector, savePath }) => {
    try {
      const p = await getPage();
      const [download] = await Promise.all([p.waitForEvent("download", { timeout: 30_000 }), p.click(selector)]);
      const resolved = path.isAbsolute(savePath) ? savePath : path.resolve(WORKSPACE_ROOT, savePath);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await download.saveAs(resolved);
      return { content: [{ type: "text" as const, text: `Downloaded to ${resolved}` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__fill",
  {
    description: "Fill a text input or textarea with a value. Use for form fields, search boxes, etc.",
    inputSchema: { selector: z.string(), value: z.string() },
  },
  async ({ selector, value }) => {
    try {
      const p = await getPage();
      await p.fill(selector, value, { timeout: 15_000 });
      return { content: [{ type: "text" as const, text: `Filled ${selector} with "${value}"` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__fill_from_env",
  {
    description:
      "Fill a text input with a value read from an environment variable on the local machine. Use this instead of browser__fill whenever the value is a secret (password, API key, etc.) so the actual secret is never sent to the model.",
    inputSchema: {
      selector: z.string(),
      env_var: z.string().describe("Name of the environment variable whose value will be typed into the field"),
    },
  },
  async ({ selector, env_var }) => {
    try {
      const value = process.env[env_var];
      if (value === undefined) {
        return { content: [{ type: "text" as const, text: `Error: environment variable "${env_var}" is not set` }], isError: true };
      }
      const p = await getPage();
      await p.fill(selector, value, { timeout: 15_000 });
      return { content: [{ type: "text" as const, text: `Filled ${selector} from env var ${env_var}` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__eval",
  {
    description: "Execute a JavaScript expression in the current page context and return the result as JSON. Use this to click elements that can't be targeted by CSS selector (e.g. buttons found by text content).",
    inputSchema: { expression: z.string().describe("JavaScript expression to evaluate in the page") },
  },
  async ({ expression }) => {
    try {
      const p = await getPage();
      const result = await p.evaluate(expression);
      return { content: [{ type: "text" as const, text: result === undefined ? "OK (void return)" : JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__wait_for",
  {
    description: "Wait for a CSS selector to appear on the page (up to 30s), or wait a fixed number of milliseconds. Use after navigation on SPAs to wait for React to finish rendering before interacting.",
    inputSchema: {
      selector: z.string().optional().describe("CSS selector to wait for"),
      ms: z.number().optional().describe("Fixed wait in milliseconds (used if no selector given)"),
    },
  },
  async ({ selector, ms }) => {
    try {
      const p = await getPage();
      if (selector) {
        await p.waitForSelector(selector, { timeout: 30_000 });
        return { content: [{ type: "text" as const, text: `Element appeared: ${selector}` }] };
      }
      await p.waitForTimeout(ms ?? 2000);
      return { content: [{ type: "text" as const, text: `Waited ${ms ?? 2000}ms` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__select",
  {
    description: "Select an option in a <select> dropdown by its visible label or value.",
    inputSchema: { selector: z.string(), option: z.string() },
  },
  async ({ selector, option }) => {
    try {
      const p = await getPage();
      await p.selectOption(selector, { label: option }, { timeout: 15_000 }).catch(
        () => p.selectOption(selector, { value: option }, { timeout: 15_000 }),
      );
      return { content: [{ type: "text" as const, text: `Selected "${option}" in ${selector}` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

// Works for: standard HTML forms where a [type=submit] button/input is a
// descendant of `selector`. Clicking p.click(selector) on a <form> element
// itself does nothing in Playwright -- you must click the submit control.
//
// Does NOT work for:
//   - JS-driven forms with no native submit button (need browser__click on a
//     custom element instead)
//   - Submit buttons that live outside the <form> tag (pass their selector
//     directly to browser__click)
//   - Multi-step wizard forms where "next" != "submit"
//
// When broadening this: consider accepting an optional explicit submitSelector
// so callers can point directly at the button when the heuristic fails.
server.registerTool(
  "browser__submit_form",
  {
    description:
      "Submit a form by clicking its [type=submit] button. Pass the selector of the form container or the submit button itself. Sends data externally (messages/payments/etc) -- gated by policy as a human checkpoint.",
    inputSchema: { selector: z.string() },
  },
  async ({ selector }) => {
    try {
      const p = await getPage();
      // Try the selector as-is first (works if it's already the submit button).
      // Fall back to finding [type=submit] within it (works if it's the <form>).
      const submitLocator = p.locator(`${selector} [type=submit]`).first();
      const hasSubmitChild = await submitLocator.count() > 0;
      if (hasSubmitChild) {
        await submitLocator.click({ timeout: 10_000 });
      } else {
        await p.click(selector, { timeout: 10_000 });
      }
      return { content: [{ type: "text" as const, text: `Submitted form via ${selector}` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

const CACHE_PATH = path.join(WORKSPACE_ROOT, "browser-cache.json");

type CacheFile = Record<string, Record<string, Record<string, unknown>>>;

async function readCache(): Promise<CacheFile> {
  try {
    return JSON.parse(await fs.readFile(CACHE_PATH, "utf-8")) as CacheFile;
  } catch {
    return {};
  }
}

server.registerTool(
  "browser__cache_read",
  {
    description:
      "Read cached browser automation data (selectors, nav steps, etc.) for a site+flow from workspace/browser-cache.json. Call this at the start of any flow before doing discovery. Returns the cached object, or a cache-miss message if nothing is stored yet.",
    inputSchema: {
      site: z.string().describe("Base URL of the site, e.g. https://example.com"),
      flow: z.string().describe("Flow name, e.g. 'login', 'products_grid'"),
    },
  },
  async ({ site, flow }) => {
    try {
      const cache = await readCache();
      const data = cache[site]?.[flow];
      if (!data) return { content: [{ type: "text" as const, text: `cache miss: no data for ${site} / ${flow}` }] };
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__cache_write",
  {
    description:
      "Persist browser automation data (selectors, nav steps, etc.) for a site+flow to workspace/browser-cache.json. Call this after a flow succeeds so future runs can skip discovery.",
    inputSchema: {
      site: z.string().describe("Base URL of the site, e.g. https://example.com"),
      flow: z.string().describe("Flow name, e.g. 'login', 'products_grid'"),
      data: z.record(z.string(), z.unknown()).describe("Selectors and other info to cache for this flow"),
    },
  },
  async ({ site, flow, data }) => {
    try {
      await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
      const cache = await readCache();
      cache[site] ??= {};
      cache[site][flow] = data;
      await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
      return { content: [{ type: "text" as const, text: `Cached ${site} / ${flow}` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
