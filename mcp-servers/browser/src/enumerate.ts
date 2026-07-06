/**
 * browser__enumerate's page-side logic, factored out of server.ts so it can be
 * unit-tested without starting the MCP server (server.ts self-connects a stdio
 * transport on import).
 *
 * The result of buildEnumerateExpr is a raw JS *expression string* fed to
 * page.evaluate -- a string, not a function, deliberately: passing a function
 * would let esbuild/tsx's keepNames transform inject an undefined `__name`
 * helper into the page context (the same hazard documented in snapshot.ts and
 * worked around in settle()/click_text). Params are inlined via JSON.stringify.
 */

export interface EnumerateOptions {
  selector: string;
  attributes?: string[];
  text?: boolean;
  limit?: number;
}

export interface EnumerateResult {
  total: number;
  returned: number;
  items: Array<Record<string, string | null>>;
}

export function buildEnumerateExpr(opts: EnumerateOptions): string {
  return `(() => {
    var els = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(opts.selector)}));
    var attrs = ${JSON.stringify(opts.attributes ?? [])};
    var includeText = ${opts.text ? "true" : "false"};
    var limit = ${opts.limit ?? 1000};
    var out = [];
    for (var i = 0; i < els.length && out.length < limit; i++) {
      var el = els[i];
      var rec = {};
      for (var j = 0; j < attrs.length; j++) { rec[attrs[j]] = el.getAttribute(attrs[j]); }
      if (includeText) { rec.text = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200); }
      out.push(rec);
    }
    return { total: els.length, returned: out.length, items: out };
  })()`;
}

/** Renders the tool's text payload from a raw evaluate result. */
export function renderEnumerate(result: EnumerateResult): string {
  const capped = result.returned < result.total ? ` (capped from ${result.total})` : "";
  return `${result.returned} match(es)${capped}:\n${JSON.stringify(result.items, null, 2)}`;
}
