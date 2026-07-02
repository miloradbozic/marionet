import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { buildSnapshot, renderSnapshot, refSelector } from "../mcp-servers/browser/src/snapshot.js";

const chromiumAvailable = existsSync(chromium.executablePath());
const TEST_SITE_URL = pathToFileURL(path.resolve(__dirname, "../test-site/index.html")).href;

describe.skipIf(!chromiumAvailable)("browser snapshot (integration)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.goto(TEST_SITE_URL);
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("lists visible interactive elements with roles, names, and refs", async () => {
    const result = await buildSnapshot(page);
    const text = result.lines.join("\n");

    expect(text).toMatch(/link "Products"/);
    expect(text).toMatch(/textbox "Username"/);
    expect(text).toMatch(/button "Log in"/);
    expect(text).toMatch(/textbox "Marketing Titel"/);
    expect(text).toMatch(/checkbox "Exklusiver Anbieter"/);
    expect(text).toMatch(/combobox "Canton" selected="Zürich"/);
    expect(text).toMatch(/searchbox "Search attributes by label or code"/);
    expect(text).toMatch(/button "Duplicate product"/);
    expect(result.lines.every((l) => /^e\d+ /.test(l))).toBe(true);
  });

  it("excludes the hidden legacy save button but includes the visible modern one", async () => {
    const result = await buildSnapshot(page, { query: "save" });
    // Exactly one Save button: the visible JS-layer one, not the display:none legacy one.
    const saveLines = result.lines.filter((l) => l.includes('button "Save"'));
    expect(saveLines).toHaveLength(1);
  });

  it("fills and clicks through refs, with no CSS selectors involved", async () => {
    const snap = await buildSnapshot(page);
    const titleRef = snap.lines.find((l) => l.includes('textbox "Marketing Titel"'))!.split(" ")[0]!;
    const saveRef = snap.lines.find((l) => l.includes('button "Save"'))!.split(" ")[0]!;

    await page.fill(refSelector(titleRef), "Phase2 ref test");
    await page.click(refSelector(saveRef));

    expect(await page.locator("#status").textContent()).toBe("Saved: Phase2 ref test");
  });

  it("shows current input values as state", async () => {
    const result = await buildSnapshot(page, { query: "marketing" });
    expect(result.lines.join("\n")).toMatch(/value="Phase2 ref test"/);
  });

  it("masks password values", async () => {
    await page.fill("#password", "supersecret");
    const result = await buildSnapshot(page, { query: "password" });
    const text = result.lines.join("\n");
    expect(text).not.toContain("supersecret");
    expect(text).toMatch(/value="•••"/);
  });

  it("respects query filter and maxElements cap", async () => {
    const filtered = await buildSnapshot(page, { query: "canton" });
    expect(filtered.lines).toHaveLength(1);

    const capped = await buildSnapshot(page, { maxElements: 3 });
    expect(capped.shown).toBe(3);
    expect(capped.totalInteractive).toBeGreaterThan(3);
    expect(renderSnapshot(capped)).toContain("3 of");
  });

  it("re-snapshot invalidates old refs (no stale duplicates)", async () => {
    await buildSnapshot(page, { query: "canton" }); // small snapshot re-refs only one element
    const staleRefCount = await page.locator("[data-marionet-ref]").count();
    expect(staleRefCount).toBe(1);
  });

  it("reports a scope error for a selector that matches nothing", async () => {
    const result = await buildSnapshot(page, { scope: "#does-not-exist" });
    expect(result.scopeError).toBeTruthy();
    expect(renderSnapshot(result)).toMatch(/^Error:/);
  });
});

describe("refSelector", () => {
  it("builds an attribute selector for valid refs", () => {
    expect(refSelector("e12")).toBe('[data-marionet-ref="e12"]');
  });

  it("rejects malformed refs", () => {
    expect(() => refSelector("body")).toThrow(/invalid ref/);
    expect(() => refSelector('e1"] , body [x="')).toThrow(/invalid ref/);
  });
});
