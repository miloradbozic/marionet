import { describe, expect, it } from "vitest";
import { describeLocator, isFragile, scoreLocator } from "../src/compiler/stability.js";

/**
 * The scorer's job is to catch anchors that rot without a redeploy. The
 * headline case is real: `open_product_detail_page` in the opari library was
 * compiled anchored to a grid row whose accessible name carries a completeness
 * percentage and an "updated" date -- both of which change when you edit the
 * product the skill exists to edit.
 */
const REAL_AKENEO_ROW = {
  role: "row",
  name: '{{sku}}SimpleTeebereiter Nordic kitchenHMD Töpfe & PfannenEnabled76%11/21/2...',
};

describe("scoreLocator", () => {
  it("passes authored labels on control roles", () => {
    for (const locator of [
      { role: "button", name: "Save" },
      { role: "button", name: "Login" },
      { role: "menuitem", name: "Products" },
      { role: "textbox", name: "Password" },
      { role: "textbox", name: "Username or Email" },
      { role: "searchbox", name: "Search attributes by label or code" },
    ]) {
      const v = scoreLocator(locator);
      expect(v.score, `${locator.role} "${locator.name}"`).toBe("stable");
      expect(v.reasons).toEqual([]);
    }
  });

  it("condemns the real Akeneo grid-row anchor, and says why", () => {
    const v = scoreLocator(REAL_AKENEO_ROW);
    expect(v.score).toBe("fragile");
    expect(isFragile(REAL_AKENEO_ROW)).toBe(true);
    // Every independent signal fires: truncation, a percentage, a date, and a
    // container role with a long name.
    expect(v.reasons.some((r) => r.includes("truncated"))).toBe(true);
    expect(v.reasons.some((r) => r.includes("percentage"))).toBe(true);
    expect(v.reasons.some((r) => r.includes("date"))).toBe(true);
    expect(v.reasons.some((r) => r.includes("container"))).toBe(true);
  });

  it("treats a truncation marker as proof of a concatenated container", () => {
    // identity.ts appends "..." only after slicing textContent at 80 chars.
    const v = scoreLocator({ role: "generic", name: "Some very long concatenation of cell texts that ran past the limit and got c..." });
    expect(v.score).toBe("fragile");
    expect(v.reasons[0]).toContain("truncated");
  });

  it("flags volatile content that no redeploy is needed to change", () => {
    expect(scoreLocator({ role: "button", name: "Complete 76%" }).score).toBe("fragile");
    expect(scoreLocator({ role: "link", name: "Updated 11/21/2026" }).score).toBe("fragile");
    expect(scoreLocator({ role: "button", name: "Starts 14:30" }).score).toBe("fragile");
    expect(scoreLocator({ role: "link", name: "Order 90138490" }).score).toBe("fragile");
  });

  it("does not punish a skill for its own parameters", () => {
    // {{sku}} is the compiler working correctly -- the anchor is parameterized,
    // not run-specific. A digit check that fired on it would flag every good skill.
    const v = scoreLocator({ role: "link", name: "{{sku}}" });
    expect(v.score).toBe("stable");
    expect(scoreLocator({ role: "button", name: "Open {{product_id}}" }).score).toBe("stable");
  });

  it("marks container roles weak even when their name is short", () => {
    // row "ERP" is honest today, but a row has no label of its own: the name is
    // whatever its cells render, so it can shift without any redesign.
    const v = scoreLocator({ role: "row", name: "ERP" });
    expect(v.score).toBe("weak");
    expect(v.reasons[0]).toContain("container");
  });

  it("marks a long name on a control role weak, not fragile", () => {
    const v = scoreLocator({ role: "button", name: "Click here to select a record from the catalogue" });
    expect(v.score).toBe("weak");
    expect(v.reasons[0]).toContain("chars");
  });

  it("keeps the worst verdict when signals disagree", () => {
    // Container (weak) + percentage (fragile) must not average out to weak.
    const v = scoreLocator({ role: "row", name: "ERP 76%" });
    expect(v.score).toBe("fragile");
  });
});

describe("describeLocator", () => {
  it("renders role + name, truncated for one-line reports", () => {
    expect(describeLocator({ role: "button", name: "Save" })).toBe('button "Save"');
    const long = describeLocator(REAL_AKENEO_ROW, 20);
    expect(long.startsWith('row "')).toBe(true);
    expect(long.length).toBeLessThan(30);
  });
});
