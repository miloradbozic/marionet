import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";
import { buildEnumerateExpr, renderEnumerate, type EnumerateResult } from "../mcp-servers/browser/src/enumerate.js";

// Use the installed Google Chrome (channel "chrome"), same as golden-loop --
// the bundled Playwright chromium isn't installed in this environment.
let chromeAvailable = true;
try {
  execSync("google-chrome --version", { stdio: "ignore" });
} catch {
  chromeAvailable = false;
}

// A miniature Akeneo-shaped attribute grid: group-header rows interspersed with
// attribute rows, one attribute (weight) carrying two inputs (value + unit).
const FIXTURE = `
  <table><tbody>
    <tr class="attribute_group_row"><td>ERP</td></tr>
    <tr data-attribute="ean"><td><label>EAN-Code</label><input value="5706631267335"></td></tr>
    <tr data-attribute="brand"><td><label>Marke</label><input value="Acme"></td></tr>
    <tr class="attribute_group_row"><td>Spezifikationen</td></tr>
    <tr data-attribute="weight"><td><label>Gewicht</label><input value="760"><input value="Gram"></td></tr>
  </tbody></table>`;

async function run(page: Page, opts: Parameters<typeof buildEnumerateExpr>[0]): Promise<EnumerateResult> {
  return (await page.evaluate(buildEnumerateExpr(opts))) as EnumerateResult;
}

describe.skipIf(!chromeAvailable)("browser__enumerate (integration)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    page = await browser.newPage();
    await page.setContent(FIXTURE);
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("lists every matching element in document order with requested attributes", async () => {
    const res = await run(page, { selector: "tr[data-attribute]", attributes: ["data-attribute"] });
    expect(res.total).toBe(3);
    expect(res.returned).toBe(3);
    expect(res.items.map((r) => r["data-attribute"])).toEqual(["ean", "brand", "weight"]);
  });

  it("includes trimmed text (label), which is textContent -- note it excludes input values", async () => {
    const res = await run(page, { selector: "tr[data-attribute='ean']", attributes: ["data-attribute"], text: true });
    // textContent is the label only; <input value> is NOT part of textContent,
    // so `text` gives clean attribute labels for a catalog, not field values.
    expect(res.items[0]).toMatchObject({ "data-attribute": "ean", text: "EAN-Code" });
  });

  it("reads arbitrary attributes and preserves document order across group + attribute rows", async () => {
    // Enumerating all rows lets a caller stitch attribute -> group by order:
    // each attribute row belongs to the most recent preceding group header.
    const res = await run(page, { selector: "tr", attributes: ["class", "data-attribute"] });
    let group = "";
    const catalog: Array<{ code: string; group: string }> = [];
    for (const r of res.items) {
      if ((r.class ?? "").includes("attribute_group_row")) group = "";
      if (r["data-attribute"]) catalog.push({ code: r["data-attribute"]!, group });
    }
    // group left blank above intentionally; re-derive with text to prove order:
    const withText = await run(page, { selector: "tr", attributes: ["class", "data-attribute"], text: true });
    let g = "";
    const named: Array<{ code: string; group: string }> = [];
    for (const r of withText.items) {
      if ((r.class ?? "").includes("attribute_group_row")) { g = r.text!; continue; }
      if (r["data-attribute"]) named.push({ code: r["data-attribute"]!, group: g });
    }
    expect(named).toEqual([
      { code: "ean", group: "ERP" },
      { code: "brand", group: "ERP" },
      { code: "weight", group: "Spezifikationen" },
    ]);
    expect(catalog).toHaveLength(3);
  });

  it("caps at limit and reports the true total", async () => {
    const res = await run(page, { selector: "tr[data-attribute]", attributes: ["data-attribute"], limit: 2 });
    expect(res.total).toBe(3);
    expect(res.returned).toBe(2);
    expect(renderEnumerate(res)).toContain("2 match(es) (capped from 3)");
  });

  it("returns an empty list (not an error) when nothing matches", async () => {
    const res = await run(page, { selector: ".does-not-exist" });
    expect(res).toMatchObject({ total: 0, returned: 0, items: [] });
  });
});
