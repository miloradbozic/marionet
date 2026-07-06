import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium, type Browser, type Page } from "playwright";
import path from "node:path";
import { promises as fs } from "node:fs";
import { buildSnapshot, renderSnapshot, refSelector, REF_MISS_HINT } from "./snapshot.js";
import { buildEnumerateExpr, renderEnumerate, type EnumerateResult } from "./enumerate.js";
import { DESCRIBE_ELEMENT_SRC, describeBySelector, targetSuffix, type ElementIdentity } from "./identity.js";

// Never launches its own browser -- always attaches over CDP to a browser the
// human started and authenticated manually. Re-triggering an automated login
// flow is exactly the anti-automation block this is designed to avoid (see
// README "Ground rules").
const CDP_ENDPOINT = process.env.MARIONET_BROWSER_CDP_ENDPOINT ?? "http://localhost:9222";
const WORKSPACE_ROOT = path.resolve(process.cwd(), "workspace");

// Timeout for a single element action (click/fill/press/select). With
// auto-settle (see settle()) the page has stopped changing before we act, so
// an element that still isn't actionable within this window almost always
// means the WRONG selector, not a slow one -- fail fast and let the model
// re-perceive rather than burning 15s per miss.
const ACTION_TIMEOUT_MS = 6_000;

let browser: Browser | undefined;
let page: Page | undefined;
const hookedContexts = new WeakSet<ReturnType<Browser["contexts"]>[number]>();

// Connects lazily, on first browser tool call, so a run that never touches
// the browser doesn't fail just because Chrome isn't running with
// --remote-debugging-port yet.
//
// Page selection: sticky. We keep using the page we already have until it
// closes. A "page" event on the context (popup, target=_blank) switches the
// active page to the new one -- clicking something that opens a tab should
// mean subsequent actions target that tab, not the original.
async function getPage(): Promise<Page> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    page = undefined;
  }
  const context = browser.contexts()[0] ?? (await browser.newContext());
  if (!hookedContexts.has(context)) {
    hookedContexts.add(context);
    context.on("page", (newPage) => {
      page = newPage;
    });
  }
  if (page && !page.isClosed()) return page;
  page = context.pages().find((p) => !p.isClosed()) ?? (await context.newPage());
  return page;
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

// Playwright's getByRole() accepts a fixed union of ARIA roles; this widens a
// runtime string into that parameter type after we've decided to trust it.
type AriaRole = Parameters<Page["getByRole"]>[0];

/**
 * Resolves an element-targeting tool's arguments to a Playwright-actionable
 * handle. Two addressing modes:
 *   - `selector` (CSS)      -- what the model uses during exploration
 *   - `role` + `name` (semantic) -- what compiled skills use during replay,
 *     because role + accessible name survive redeploys that churn CSS classes.
 */
function semanticLocator(p: Page, role: string, name: string) {
  return p.getByRole(role as AriaRole, { name, exact: true }).first();
}

// Human-like "wait for the page to stop changing" before returning control.
// The #1 source of flakiness on SPAs is acting on a page that is still
// re-rendering after the previous action (stale rows, unmounted fields, etc.).
// A person instinctively waits a beat and looks; the model does not, so we
// bake the beat into every mutating tool. We resolve once the DOM has been
// quiet for `quietMs`, or after `maxMs` regardless -- adaptive, like a human:
// near-instant on a static page, longer only while things are actually moving.
// Passed as a raw string so esbuild/tsx's keepNames transform can't inject an
// undefined `__name` helper into the page context (see snapshot.ts for the
// same hazard).
async function settle(page: Page, quietMs = 500, maxMs = 4000): Promise<void> {
  try {
    await page.evaluate(
      `new Promise((resolve) => {
        if (!document.body) { resolve(); return; }
        var start = Date.now();
        var timer;
        var obs;
        function done() { try { if (obs) obs.disconnect(); } catch (e) {} clearTimeout(timer); resolve(); }
        function bump() {
          clearTimeout(timer);
          var remaining = ${maxMs} - (Date.now() - start);
          timer = setTimeout(done, Math.min(${quietMs}, Math.max(0, remaining)));
        }
        try {
          obs = new MutationObserver(bump);
          obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        } catch (e) {}
        bump();
        setTimeout(done, ${maxMs});
      })`,
    );
  } catch {
    // Context destroyed (navigation) or page closed mid-settle -- nothing to wait for.
  }
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
      await settle(p);
      return { content: [{ type: "text" as const, text: `Navigated to ${p.url()} ("${await p.title()}")` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__snapshot",
  {
    description:
      "Structured snapshot of the current page: every visible interactive element (buttons, links, inputs, selects, ...) with its role, accessible name, current state, and a ref (e1, e2, ...). Use refs with browser__click_ref / browser__fill_ref instead of guessing CSS selectors. Refs expire on navigation or framework re-render -- re-snapshot after page-changing actions. Use `query` to filter elements by text, `scope` to limit to a page region.",
    inputSchema: {
      query: z.string().optional().describe("Case-insensitive substring filter on element lines, e.g. 'save' or 'marketing'"),
      scope: z.string().optional().describe("CSS selector to scope the snapshot to a page region"),
      maxElements: z.number().int().positive().max(1000).optional().describe("Cap on returned elements (default 300)"),
    },
  },
  async ({ query, scope, maxElements }) => {
    try {
      const p = await getPage();
      const result = await buildSnapshot(p, { query, scope, maxElements });
      return { content: [{ type: "text" as const, text: renderSnapshot(result) }], isError: Boolean(result.scopeError) };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__click_ref",
  {
    description:
      "Click an element by its snapshot ref (e.g. 'e12') from browser__snapshot. Preferred over browser__click with CSS selectors.",
    inputSchema: { ref: z.string().describe("Snapshot ref, e.g. e12") },
  },
  async ({ ref }) => {
    try {
      const p = await getPage();
      const selector = refSelector(ref);
      if ((await p.locator(selector).count()) === 0) {
        return { content: [{ type: "text" as const, text: `Error: ${REF_MISS_HINT}` }], isError: true };
      }
      const identity = await describeBySelector(p, selector);
      await p.click(selector, { timeout: ACTION_TIMEOUT_MS });
      await settle(p);
      return { content: [{ type: "text" as const, text: `Clicked ${ref}${targetSuffix(identity)}` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__click_text",
  {
    description:
      "Click the element whose visible text matches `text` (substring by default, or exact). Use this to click a table row, list item, link, or button by what it SAYS -- e.g. open a grid row by its ID/SKU -- instead of hand-writing JS in browser__eval or guessing a CSS selector. If the match is inside a table row (<tr>) the whole row is clicked (data grids open on row click); otherwise the nearest <a>/<button> ancestor, else the matched element. Returns what was clicked and whether the page navigated -- a click that does not navigate when you expected an edit page means the row wasn't really opened. Returns an error if no element contains the text (for a search result, that means no such row -- confirm the empty state, don't retry forever).",
    inputSchema: {
      text: z.string().describe("Visible text to match, e.g. a product SKU or a link label"),
      exact: z.boolean().optional().describe("Require the matched element's text to equal `text` exactly (default: substring match)"),
    },
  },
  async ({ text, exact }) => {
    try {
      const p = await getPage();
      const before = p.url();
      // Raw string (not a function) so esbuild/tsx keepNames can't inject an
      // undefined __name into the page (same hazard as snapshot.ts / settle).
      const expr = `(() => {
        var norm = function (s) { return (s || "").replace(/\\s+/g, " ").trim(); };
        var t = norm(${JSON.stringify(text)});
        var exact = ${exact ? "true" : "false"};
        var all = Array.prototype.slice.call(document.querySelectorAll("body *"));
        var matches = all.filter(function (el) {
          var et = norm(el.textContent);
          return exact ? et === t : et.indexOf(t) !== -1;
        });
        // Deepest (fewest descendants) match first: target the specific cell, not a wrapping container.
        matches.sort(function (a, b) { return a.querySelectorAll("*").length - b.querySelectorAll("*").length; });
        var hit = matches[0];
        if (!hit) return null;
        var target = hit.closest("tr") || hit.closest("a,button,[role=button],[role=link]") || hit;
        var sem = (${DESCRIBE_ELEMENT_SRC})(target);
        try { target.scrollIntoView({ block: "center" }); } catch (e) {}
        target.click();
        return { tag: target.tagName, text: norm(target.textContent).slice(0, 80), sem: sem };
      })()`;
      const clicked = (await p.evaluate(expr)) as { tag: string; text: string; sem: ElementIdentity | null } | null;
      if (!clicked) {
        return {
          content: [{ type: "text" as const, text: `No element found containing text "${text}".` }],
          isError: true,
        };
      }
      await settle(p);
      const navigated = p.url() !== before;
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Clicked ${clicked.tag} "${clicked.text}"${targetSuffix(clicked.sem)}` +
              (navigated ? ` — navigated to ${p.url()}` : " — page did not navigate"),
          },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__fill_ref",
  {
    description:
      "Fill a text input/textarea by its snapshot ref (e.g. 'e7') from browser__snapshot. Preferred over browser__fill with CSS selectors. For secrets use browser__fill_from_env with the ref argument instead.",
    inputSchema: {
      ref: z.string().describe("Snapshot ref, e.g. e7"),
      value: z.string(),
    },
  },
  async ({ ref, value }) => {
    try {
      const p = await getPage();
      const selector = refSelector(ref);
      if ((await p.locator(selector).count()) === 0) {
        return { content: [{ type: "text" as const, text: `Error: ${REF_MISS_HINT}` }], isError: true };
      }
      const identity = await describeBySelector(p, selector);
      await p.fill(selector, value, { timeout: ACTION_TIMEOUT_MS });
      await settle(p);
      return { content: [{ type: "text" as const, text: `Filled ${ref} with "${value}"${targetSuffix(identity)}` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__click",
  {
    description:
      "Click an element on the current page. Target it with a CSS `selector`, or semantically with ARIA `role` + accessible `name` (as reported by browser__snapshot lines / [target: ...] suffixes) -- semantic targeting survives redeploys that change CSS class names.",
    inputSchema: {
      selector: z.string().optional().describe("CSS selector"),
      role: z.string().optional().describe("ARIA role, e.g. 'button' (use with name)"),
      name: z.string().optional().describe("Accessible name, e.g. 'Save' (use with role)"),
    },
  },
  async ({ selector, role, name }) => {
    try {
      const p = await getPage();
      if (selector) {
        const identity = await describeBySelector(p, selector);
        await p.click(selector, { timeout: ACTION_TIMEOUT_MS });
        await settle(p);
        return { content: [{ type: "text" as const, text: `Clicked ${selector}${targetSuffix(identity)}` }] };
      }
      if (role && name) {
        await semanticLocator(p, role, name).click({ timeout: ACTION_TIMEOUT_MS });
        await settle(p);
        return { content: [{ type: "text" as const, text: `Clicked ${role} "${name}"` }] };
      }
      return { content: [{ type: "text" as const, text: "Error: provide selector, or role + name" }], isError: true };
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
      // Same fail-fast rule as click/fill: a selector that hasn't matched
      // within the action timeout is almost always the WRONG selector -- do
      // not burn Playwright's default 30s (seen live: a finish verification
      // extracting "h1" on a page with no h1 stalled the run for 30s per try).
      if (fmt === "screenshot") {
        const buffer = selector
          ? await p.locator(selector).screenshot({ timeout: ACTION_TIMEOUT_MS })
          : await p.screenshot();
        return { content: [{ type: "image" as const, data: buffer.toString("base64"), mimeType: "image/png" }] };
      }
      const locator = selector ? p.locator(selector) : p.locator("body");
      const text =
        fmt === "html"
          ? await locator.innerHTML({ timeout: ACTION_TIMEOUT_MS })
          : await locator.innerText({ timeout: ACTION_TIMEOUT_MS });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__enumerate",
  {
    description:
      "List every element matching a CSS selector, in document order, returning chosen data per element as a JSON array. Use this to read the STRUCTURE of a repeated region in one call -- e.g. every row of a data grid, every card in a list, or (on an Akeneo product page) every attribute row (`tr[data-attribute]`) to learn the full set of attribute codes without clicking through them. Far cheaper and more reliable than a full browser__extract + parsing prose, and unlike browser__snapshot it can read arbitrary DOM attributes (data-*, class) you name, not just interactive elements. Returns [] if nothing matches (an empty region, not an error).",
    inputSchema: {
      selector: z.string().describe("CSS selector for the repeated element, e.g. \"tr[data-attribute]\" or \"li.result\""),
      attributes: z.array(z.string()).optional().describe("DOM attribute names to read per element, e.g. [\"data-attribute\", \"class\"]"),
      text: z.boolean().optional().describe("Include each element's trimmed visible text (capped at 200 chars) as a `text` field"),
      limit: z.number().int().positive().max(2000).optional().describe("Max elements to return (default 1000)"),
    },
  },
  async ({ selector, attributes, text, limit }) => {
    try {
      const p = await getPage();
      const result = (await p.evaluate(buildEnumerateExpr({ selector, attributes, text, limit }))) as EnumerateResult;
      return { content: [{ type: "text" as const, text: renderEnumerate(result) }] };
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
    description:
      "Fill a text input or textarea with a value. Use for form fields, search boxes, etc. Target with a CSS `selector`, or semantically with ARIA `role` + accessible `name` -- semantic targeting survives redeploys that change CSS class names.",
    inputSchema: {
      selector: z.string().optional().describe("CSS selector"),
      value: z.string(),
      role: z.string().optional().describe("ARIA role, e.g. 'textbox' (use with name)"),
      name: z.string().optional().describe("Accessible name (use with role)"),
    },
  },
  async ({ selector, value, role, name }) => {
    try {
      const p = await getPage();
      if (selector) {
        const identity = await describeBySelector(p, selector);
        // .first(): a selector legitimately matching >1 element (e.g. an
        // Akeneo measurement attribute's value + unit inputs both under the
        // same row selector) should fill the first rather than hard-error --
        // the read side (document.querySelector) already takes the first
        // match, so this keeps fill/read semantics consistent.
        await p.locator(selector).first().fill(value, { timeout: ACTION_TIMEOUT_MS });
        await settle(p);
        return { content: [{ type: "text" as const, text: `Filled ${selector} with "${value}"${targetSuffix(identity)}` }] };
      }
      if (role && name) {
        await semanticLocator(p, role, name).fill(value, { timeout: ACTION_TIMEOUT_MS });
        await settle(p);
        return { content: [{ type: "text" as const, text: `Filled ${role} "${name}" with "${value}"` }] };
      }
      return { content: [{ type: "text" as const, text: "Error: provide selector, or role + name" }], isError: true };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__press",
  {
    description:
      "Press a keyboard key, optionally after focusing a field. Use this to submit a search box or form that only reacts to Enter (browser__fill sets a value but sends no keystrokes, so debounced/keyboard-driven searches never fire). Key names follow Playwright: 'Enter', 'Escape', 'Tab', 'ArrowDown', etc. To focus a field first, prefer `ref` from browser__snapshot over guessing a CSS `selector`; if neither is given the key goes to the currently focused element.",
    inputSchema: {
      key: z.string().describe("Key to press, e.g. 'Enter'"),
      ref: z.string().optional().describe("Snapshot ref from browser__snapshot to focus before pressing (preferred)"),
      selector: z.string().optional().describe("CSS selector to focus before pressing, if no snapshot ref is available"),
    },
  },
  async ({ key, ref, selector }) => {
    try {
      const p = await getPage();
      const target = ref ? refSelector(ref) : selector;
      let identity: ElementIdentity | null = null;
      if (target) {
        if (ref && (await p.locator(target).count()) === 0) {
          return { content: [{ type: "text" as const, text: `Error: ${REF_MISS_HINT}` }], isError: true };
        }
        identity = await describeBySelector(p, target);
        await p.press(target, key, { timeout: ACTION_TIMEOUT_MS });
      } else {
        await p.keyboard.press(key);
      }
      await settle(p);
      return {
        content: [{ type: "text" as const, text: `Pressed ${key}${target ? ` on ${ref ?? selector}${targetSuffix(identity)}` : ""}` }],
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__fill_from_env",
  {
    description:
      "Fill a text input with a value read from an environment variable on the local machine. Use this instead of browser__fill/browser__fill_ref whenever the value is a secret (password, API key, etc.) so the actual secret is never sent to the model. Target the field with either a snapshot ref (preferred) or a CSS selector.",
    inputSchema: {
      ref: z.string().optional().describe("Snapshot ref from browser__snapshot, e.g. e7 (preferred)"),
      selector: z.string().optional().describe("CSS selector, if no snapshot ref is available"),
      env_var: z.string().describe("Name of the environment variable whose value will be typed into the field"),
    },
  },
  async ({ ref, selector, env_var }) => {
    try {
      const value = process.env[env_var];
      if (value === undefined) {
        return { content: [{ type: "text" as const, text: `Error: environment variable "${env_var}" is not set` }], isError: true };
      }
      if (!ref && !selector) {
        return { content: [{ type: "text" as const, text: "Error: provide either ref or selector" }], isError: true };
      }
      const p = await getPage();
      const target = ref ? refSelector(ref) : selector!;
      if (ref && (await p.locator(target).count()) === 0) {
        return { content: [{ type: "text" as const, text: `Error: ${REF_MISS_HINT}` }], isError: true };
      }
      const identity = await describeBySelector(p, target);
      await p.fill(target, value, { timeout: ACTION_TIMEOUT_MS });
      await settle(p);
      return { content: [{ type: "text" as const, text: `Filled ${ref ?? selector} from env var ${env_var}${targetSuffix(identity)}` }] };
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
      await settle(p);
      return { content: [{ type: "text" as const, text: result === undefined ? "OK (void return)" : JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__wait_for",
  {
    description: "Wait for a CSS selector to appear on the page (default 8s, hard-capped at 12s), or wait a fixed number of milliseconds. Use after navigation on SPAs to wait for React to finish rendering before interacting. If a selector has not appeared within ~8s it is almost always the WRONG selector, not a slow one -- take a browser__snapshot to find the real element. Do NOT keep raising timeoutMs and re-waiting; the cap will not let you wait longer, and a missing element will still be missing.",
    inputSchema: {
      selector: z.string().optional().describe("CSS selector to wait for"),
      ms: z.number().optional().describe("Fixed wait in milliseconds (used if no selector given)"),
      timeoutMs: z.number().optional().describe("How long to wait for the selector, default 8000, capped at 12000"),
    },
  },
  async ({ selector, ms, timeoutMs }) => {
    try {
      const p = await getPage();
      if (selector) {
        await p.waitForSelector(selector, { timeout: Math.min(timeoutMs ?? 8_000, 12_000) });
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
  "browser__scroll_until_visible",
  {
    description:
      "Repeatedly scrolls the window until a CSS selector matches an element, or gives up after maxAttempts. Use this instead of guessing how many pixels to scroll (or chaining several browser__scroll calls) when content is virtualized/lazy-mounted and you know the target's selector but not where it sits on the page -- e.g. an Akeneo attribute row identified by its data-attribute code, regardless of which attribute group it happens to be under. One call replaces a blind, page-specific scroll sequence with a general, reusable search that works for any target selector.",
    inputSchema: {
      selector: z.string().describe("CSS selector to find, e.g. \"tr[data-attribute='ean']\""),
      amount: z.number().optional().describe("Pixels to scroll per attempt (default 800)"),
      maxAttempts: z.number().int().positive().max(50).optional().describe("Max scroll attempts before giving up (default 15)"),
    },
  },
  async ({ selector, amount, maxAttempts }) => {
    try {
      const p = await getPage();
      const px = amount ?? 800;
      const attempts = maxAttempts ?? 15;
      for (let i = 0; i <= attempts; i++) {
        if ((await p.locator(selector).count()) > 0) {
          const identity = await describeBySelector(p, selector);
          // .first(): a selector legitimately matching >1 element (e.g. a
          // measurement attribute's value + unit inputs under one row) must
          // scroll the first, not strict-mode-error -- same rule as
          // browser__reveal / browser__fill.
          await p.locator(selector).first().scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
          await settle(p);
          return { content: [{ type: "text" as const, text: `Found ${selector} after ${i} scroll(s)${targetSuffix(identity)}` }] };
        }
        if (i === attempts) break;
        await p.mouse.wheel(0, px);
        await settle(p);
      }
      return {
        content: [{ type: "text" as const, text: `Error: "${selector}" not found after ${attempts} scroll attempts (${attempts * px}px total). It may not exist on this page, or need a larger amount/maxAttempts.` }],
        isError: true,
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__reveal",
  {
    description:
      "Finds a target that's hidden inside a collapsed/accordion section (not just below the fold): tries each element matching sectionSelector in turn -- clicking it to expand/toggle, then scrolling -- until targetSelector matches or every section has been tried. Use this instead of browser__scroll_until_visible when content lives inside a collapsible section whose header must be clicked open first (e.g. Akeneo's product attribute groups, each a `tr.attribute_group_row`) -- plain scrolling alone never reveals it because the collapsed section has no height to scroll to. Works for any attribute/field by target selector alone; the caller never needs to know which section holds it.",
    inputSchema: {
      targetSelector: z.string().describe("CSS selector for what you're trying to reveal, e.g. \"tr[data-attribute='ean'] input\""),
      sectionSelector: z.string().describe("CSS selector matching every collapsible section header on the page, e.g. \"tr.attribute_group_row\""),
      scrollAmount: z.number().optional().describe("Pixels to scroll after clicking a section, if the target still isn't visible (default 800)"),
      maxSections: z.number().int().positive().max(50).optional().describe("Max section headers to try before giving up (default 20)"),
    },
  },
  async ({ targetSelector, sectionSelector, scrollAmount, maxSections }) => {
    try {
      const p = await getPage();
      const px = scrollAmount ?? 800;

      const found = async (): Promise<boolean> => (await p.locator(targetSelector).count()) > 0;

      if (await found()) {
        await p.locator(targetSelector).first().scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
        await settle(p);
        return { content: [{ type: "text" as const, text: `Found ${targetSelector} without expanding any section` }] };
      }

      const sectionCount = await p.locator(sectionSelector).count();
      if (sectionCount === 0) {
        return { content: [{ type: "text" as const, text: `Error: no elements matched sectionSelector "${sectionSelector}"` }], isError: true };
      }
      const limit = Math.min(sectionCount, maxSections ?? 20);

      for (let i = 0; i < limit; i++) {
        await p.locator(sectionSelector).nth(i).click({ timeout: ACTION_TIMEOUT_MS }).catch(() => {});
        await settle(p);
        if (await found()) {
          await p.locator(targetSelector).first().scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
          await settle(p);
          return { content: [{ type: "text" as const, text: `Found ${targetSelector} after expanding section ${i + 1}/${limit}` }] };
        }
        await p.mouse.wheel(0, px);
        await settle(p);
        if (await found()) {
          await p.locator(targetSelector).first().scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
          await settle(p);
          return { content: [{ type: "text" as const, text: `Found ${targetSelector} after expanding section ${i + 1}/${limit} and scrolling` }] };
        }
      }
      return {
        content: [{ type: "text" as const, text: `Error: "${targetSelector}" not found after trying ${limit} section(s) matching "${sectionSelector}"` }],
        isError: true,
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser__scroll",
  {
    description:
      "Scroll the page. Use this before snapshot/extract when content you expect isn't there -- many SPAs (e.g. Akeneo's product attribute groups) virtualize/lazy-mount long lists, so a section's fields don't exist in the DOM at all until scrolled into view, no matter how long you wait_for or how you query snapshot. Prefer `ref`/`selector` to scroll a specific element (e.g. a group header) into view; use `amount` to scroll the whole window by a pixel offset (negative scrolls up) when there's no specific element to target yet.",
    inputSchema: {
      ref: z.string().optional().describe("Snapshot ref to scroll into view (preferred)"),
      selector: z.string().optional().describe("CSS selector to scroll into view, if no snapshot ref is available"),
      amount: z.number().optional().describe("Pixels to scroll the whole page by (default 800; negative scrolls up); used if neither ref nor selector is given"),
    },
  },
  async ({ ref, selector, amount }) => {
    try {
      const p = await getPage();
      const target = ref ? refSelector(ref) : selector;
      if (target) {
        if (ref && (await p.locator(target).count()) === 0) {
          return { content: [{ type: "text" as const, text: `Error: ${REF_MISS_HINT}` }], isError: true };
        }
        const identity = await describeBySelector(p, target);
        await p.locator(target).scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
        await settle(p);
        return { content: [{ type: "text" as const, text: `Scrolled ${ref ?? selector} into view${targetSuffix(identity)}` }] };
      }
      const px = amount ?? 800;
      await p.mouse.wheel(0, px);
      await settle(p);
      return { content: [{ type: "text" as const, text: `Scrolled window by ${px}px` }] };
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
      const identity = await describeBySelector(p, selector);
      await p.selectOption(selector, { label: option }, { timeout: ACTION_TIMEOUT_MS }).catch(
        () => p.selectOption(selector, { value: option }, { timeout: ACTION_TIMEOUT_MS }),
      );
      await settle(p);
      return { content: [{ type: "text" as const, text: `Selected "${option}" in ${selector}${targetSuffix(identity)}` }] };
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
        await submitLocator.click({ timeout: ACTION_TIMEOUT_MS });
      } else {
        await p.click(selector, { timeout: ACTION_TIMEOUT_MS });
      }
      await settle(p);
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
