import type { Page } from "playwright";

/**
 * Semantic identity of an acted-on element: its ARIA role + accessible name.
 *
 * Every element-targeting tool reports this in its result text (a
 * ` [target: role "name"]` suffix) so the trajectory compiler can anchor
 * compiled skill steps to the element's semantic identity instead of the raw
 * CSS selector the model happened to use. Selectors built from CSS-in-JS class
 * names change on every deploy; role + accessible name survive redeploys and
 * redesigns that keep the UI's meaning intact.
 *
 * The role/name derivation mirrors snapshot.ts (`roleOf`/`nameOf`) so a
 * locator captured here can be re-resolved against a later snapshot. Kept as a
 * raw JS source string so esbuild/tsx keepNames can't inject an undefined
 * `__name` helper into the page context (same hazard as snapshot.ts/settle).
 */

export interface ElementIdentity {
  role: string;
  name: string;
}

/**
 * Page-context function source: `(el: Element | null) => {role, name} | null`.
 * Self-contained; safe to interpolate into any page.evaluate expression.
 */
export const DESCRIBE_ELEMENT_SRC = `(function (el) {
  if (!el) return null;
  function textOf(node) { return ((node && node.textContent) || "").replace(/\\s+/g, " ").trim(); }
  function roleOf(el) {
    var explicit = el.getAttribute("role");
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (el.isContentEditable) return "textbox";
    if (tag === "input") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return type;
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      if (type === "search") return "searchbox";
      if (type === "range") return "slider";
      return "textbox";
    }
    if (tag === "tr") return "row";
    return "generic";
  }
  function nameOf(el) {
    var ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();
    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var parts = labelledBy.split(/\\s+/).map(function (id) {
        return textOf(document.getElementById(id));
      }).filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    var id = el.getAttribute("id");
    if (id) {
      try {
        var label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (label) { var lt = textOf(label); if (lt) return lt; }
      } catch (e) {}
    }
    var wrappingLabel = el.closest("label");
    if (wrappingLabel) { var wt = textOf(wrappingLabel); if (wt) return wt; }
    var placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    var title = el.getAttribute("title");
    if (title) return title.trim();
    var tag = el.tagName.toLowerCase();
    if (tag === "input") {
      var value = el.getAttribute("value");
      var type = (el.getAttribute("type") || "").toLowerCase();
      if (value && (type === "submit" || type === "button" || type === "reset")) return value.trim();
    }
    var text = textOf(el);
    if (text) return text.length > 80 ? text.slice(0, 77) + "..." : text;
    var nameAttr = el.getAttribute("name");
    if (nameAttr) return nameAttr.trim();
    return "";
  }
  return { role: roleOf(el), name: nameOf(el) };
})`;

/** Identity of the first element matching `selector`, or null (never throws). */
export async function describeBySelector(page: Page, selector: string): Promise<ElementIdentity | null> {
  try {
    const result = (await page.evaluate(
      `(${DESCRIBE_ELEMENT_SRC})(document.querySelector(${JSON.stringify(selector)}))`,
    )) as ElementIdentity | null;
    return result && (result.role || result.name) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Renders the parseable result-text suffix, e.g. ` [target: textbox "Search
 * attributes by label or code"]`. The name is JSON-encoded so quotes inside
 * accessible names survive a round trip through the compiler's parser.
 */
export function targetSuffix(identity: ElementIdentity | null): string {
  if (!identity || !identity.name) return "";
  return ` [target: ${identity.role} ${JSON.stringify(identity.name)}]`;
}
