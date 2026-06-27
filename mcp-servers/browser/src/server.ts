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

server.registerTool(
  "browser__submit_form",
  {
    description:
      "Submit a form by clicking its submit control. Sends data externally (messages/payments/etc) -- gated by policy as a human checkpoint.",
    inputSchema: { selector: z.string() },
  },
  async ({ selector }) => {
    try {
      const p = await getPage();
      await p.click(selector, { timeout: 15_000 });
      return { content: [{ type: "text" as const, text: `Submitted form via ${selector}` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
