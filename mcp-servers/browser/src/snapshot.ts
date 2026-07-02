import type { Page } from "playwright";

/**
 * Accessibility-style page snapshot with stable interaction refs.
 *
 * Walks the live DOM in page context, collects visible interactive elements,
 * resolves an accessible name for each (aria-label, associated <label>,
 * placeholder, text content, ...), and tags each one with a
 * `data-marionet-ref="eN"` attribute. Ref-based tools (browser__click_ref,
 * browser__fill_ref) then target `[data-marionet-ref=eN]` with normal
 * Playwright actionability checks.
 *
 * Refs are intentionally ephemeral: the attributes live on the document, so
 * navigation discards them, and a framework re-render may strip them. Tools
 * that miss a ref tell the model to re-snapshot.
 */

export interface SnapshotOptions {
  /** CSS selector to scope the walk (default: whole body). */
  scope?: string;
  /** Case-insensitive substring filter on the rendered lines. */
  query?: string;
  /** Cap on returned elements (default 300). */
  maxElements?: number;
}

export interface SnapshotResult {
  url: string;
  title: string;
  lines: string[];
  totalInteractive: number;
  shown: number;
  scopeError?: string;
}

interface CollectArgs {
  scope: string | null;
  query: string | null;
  max: number;
}

interface CollectResult {
  lines: string[];
  totalInteractive: number;
  shown: number;
  scopeError?: string;
}

/** Runs inside the page. Must stay self-contained (no outer-scope captures). */
function collectElements(args: CollectArgs): CollectResult {
  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "[contenteditable=true]",
    "[contenteditable='']",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=switch]",
    "[role=combobox]",
    "[role=listbox]",
    "[role=option]",
    "[role=menuitem]",
    "[role=menuitemcheckbox]",
    "[role=menuitemradio]",
    "[role=tab]",
    "[role=searchbox]",
    "[role=textbox]",
    "[role=slider]",
    "[role=spinbutton]",
    "[onclick]",
  ].join(", ");

  function isVisible(el: Element): boolean {
    const html = el as HTMLElement;
    if (typeof html.checkVisibility === "function") {
      return html.checkVisibility({ contentVisibilityAuto: true } as CheckVisibilityOptions);
    }
    return html.offsetParent !== null;
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if ((el as HTMLElement).isContentEditable) return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return type;
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      if (type === "search") return "searchbox";
      if (type === "range") return "slider";
      return "textbox";
    }
    return "clickable";
  }

  function textOf(node: Element | null): string {
    return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  function nameOf(el: Element): string {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }

    const id = el.getAttribute("id");
    if (id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label) {
          const t = textOf(label);
          if (t) return t;
        }
      } catch {
        /* invalid id for selector -- ignore */
      }
    }

    const wrappingLabel = el.closest("label");
    if (wrappingLabel) {
      const t = textOf(wrappingLabel);
      if (t) return t;
    }

    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();

    const title = el.getAttribute("title");
    if (title) return title.trim();

    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const value = el.getAttribute("value");
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (value && (type === "submit" || type === "button" || type === "reset")) return value.trim();
    }

    const text = textOf(el);
    if (text) return text.length > 80 ? `${text.slice(0, 77)}...` : text;

    const name = el.getAttribute("name");
    if (name) return name.trim();

    const testId = el.getAttribute("data-testid");
    if (testId) return `[data-testid=${testId}]`;

    return "";
  }

  function stateOf(el: Element): string[] {
    const parts: string[] = [];
    const tag = el.tagName.toLowerCase();

    if (tag === "input") {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (input.checked) parts.push("checked");
      } else if (type === "password") {
        if (input.value) parts.push('value="•••"');
      } else if (input.value) {
        const v = input.value.length > 40 ? `${input.value.slice(0, 37)}...` : input.value;
        parts.push(`value="${v}"`);
      }
    } else if (tag === "textarea") {
      const value = (el as HTMLTextAreaElement).value;
      if (value) {
        const v = value.length > 40 ? `${value.slice(0, 37)}...` : value;
        parts.push(`value="${v}"`);
      }
    } else if (tag === "select") {
      const select = el as HTMLSelectElement;
      const selected = select.selectedOptions[0];
      if (selected) parts.push(`selected="${textOf(selected)}"`);
    }

    if ((el as HTMLInputElement).disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    if (el.getAttribute("aria-expanded")) parts.push(`expanded=${el.getAttribute("aria-expanded")}`);
    if (el.getAttribute("aria-checked") && !parts.includes("checked")) {
      parts.push(`checked=${el.getAttribute("aria-checked")}`);
    }
    return parts;
  }

  // Stale refs from a previous snapshot of this same document are misleading;
  // clear them so a ref always refers to the latest snapshot.
  for (const el of Array.from(document.querySelectorAll("[data-marionet-ref]"))) {
    el.removeAttribute("data-marionet-ref");
  }

  const root = args.scope ? document.querySelector(args.scope) : document.body;
  if (!root) {
    return { lines: [], totalInteractive: 0, shown: 0, scopeError: `scope selector matched nothing: ${args.scope}` };
  }

  const seen = new Set<Element>();
  const candidates: Element[] = [];
  for (const el of Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR))) {
    if (!seen.has(el) && isVisible(el)) {
      seen.add(el);
      candidates.push(el);
    }
  }

  const query = args.query ? args.query.toLowerCase() : null;
  const lines: string[] = [];
  let refCounter = 0;
  let shown = 0;

  for (const el of candidates) {
    const role = roleOf(el);
    const name = nameOf(el);
    const state = stateOf(el);
    const line = `${role} "${name}"${state.length ? " " + state.join(" ") : ""}`;
    if (query && !line.toLowerCase().includes(query)) continue;
    if (shown >= args.max) break;
    refCounter++;
    const ref = `e${refCounter}`;
    el.setAttribute("data-marionet-ref", ref);
    lines.push(`${ref} ${line}`);
    shown++;
  }

  return { lines, totalInteractive: candidates.length, shown };
}

export async function buildSnapshot(page: Page, opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  // tsx/esbuild compiles with keepNames, which injects `__name(...)` helper
  // calls into function bodies. Playwright serializes collectElements into
  // the page, where that helper doesn't exist -- shim it first, or every
  // snapshot fails with "ReferenceError: __name is not defined" in
  // production (but not under vitest, which compiles without the helper).
  await page.evaluate("void (globalThis.__name = globalThis.__name || ((fn) => fn))");
  const collected = await page.evaluate(collectElements, {
    scope: opts.scope ?? null,
    query: opts.query ?? null,
    max: opts.maxElements ?? 300,
  });
  return { url: page.url(), title: await page.title(), ...collected };
}

export function renderSnapshot(result: SnapshotResult): string {
  if (result.scopeError) return `Error: ${result.scopeError}`;
  const header = [
    `Page: "${result.title}" — ${result.url}`,
    `${result.shown} of ${result.totalInteractive} visible interactive elements` +
      (result.shown < result.totalInteractive ? " (filtered/capped; use query/scope to narrow, or raise maxElements)" : "") +
      ". Refs expire on navigation or re-render — re-snapshot if a ref fails.",
  ];
  return [...header, "", ...result.lines].join("\n");
}

const REF_PATTERN = /^e\d+$/;

/** Validated CSS selector for a snapshot ref; throws on malformed refs. */
export function refSelector(ref: string): string {
  if (!REF_PATTERN.test(ref)) {
    throw new Error(`invalid ref "${ref}" -- expected a snapshot ref like "e12"`);
  }
  return `[data-marionet-ref="${ref}"]`;
}

export const REF_MISS_HINT =
  "Ref not found on the current page. Refs expire on navigation and framework re-renders -- call browser__snapshot again and use a fresh ref.";
