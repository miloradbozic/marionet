import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseEvents,
  extractTrajectory,
  assertCompilable,
  parseTargetSuffix,
  CompileError,
} from "../src/compiler/trajectory.js";
import { detectLiterals, buildMapping, parameterizeStep, parameterizePostCondition } from "../src/compiler/parameterize.js";
import { compileRun } from "../src/compiler/compile.js";
import { monolithSegmenter, validateSegmentation, type Segmenter, type Segmentation } from "../src/compiler/segment.js";
import { healCount } from "../src/compiler/skill.types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureEvents = parseEvents(readFileSync(path.join(here, "fixtures", "akeneo-set-ean.events.jsonl"), "utf-8"));
const TASK = "In Akeneo, open product 901384900 and set the EAN attribute to 1234567890999";

describe("trajectory extraction", () => {
  it("extracts executed steps and the passing verification as a post-condition", () => {
    const { steps, postCondition } = extractTrajectory(fixtureEvents);

    expect(steps.map((s) => s.tool)).toEqual([
      "browser__navigate",
      "browser__navigate",
      "browser__fill",
      "browser__press",
      "browser__click_text",
      "browser__fill",
      "browser__fill",
      "browser__eval", // the Save click
    ]);
    // The final read-only eval that duplicates the verification is dropped.
    expect(postCondition.tool).toBe("browser__eval");
    expect(postCondition.expectPattern).toBe("1234567890999");
    // Steps carry their recorded result text for segmentation grounding.
    expect(steps[4]!.resultText).toContain("navigated to");
  });

  it("assertCompilable accepts a verified success and rejects otherwise", () => {
    expect(() => assertCompilable(fixtureEvents, "success")).not.toThrow();
    expect(() => assertCompilable(fixtureEvents, "failure")).toThrow(CompileError);
    expect(() => assertCompilable([{ type: "finish_task", status: "success" }], "success")).toThrow(/verification/);
  });

  it("parses semantic-locator suffixes from result texts", () => {
    expect(parseTargetSuffix('Filled input[x] with "EAN" [target: textbox "Search attributes by label or code"]')).toEqual({
      role: "textbox",
      name: "Search attributes by label or code",
    });
    expect(parseTargetSuffix('Clicked TR "901..." [target: row "Say \\"hi\\""] — navigated to /x')).toEqual({
      role: "row",
      name: 'Say "hi"',
    });
    expect(parseTargetSuffix("Clicked .btn")).toBeUndefined();
    expect(parseTargetSuffix('Filled x [target: textbox ""]')).toBeUndefined();
  });

  it("drops perception-only steps (snapshot/extract/cache) -- replay has no eyes", () => {
    const events = [
      {
        type: "model_response",
        toolUses: [
          { id: "t0", name: "browser__cache_read", input: { site: "x", flow: "y" } },
          { id: "t1", name: "browser__snapshot", input: {} },
          { id: "t2", name: "browser__fill", input: { selector: "#a", value: "1" } },
          { id: "t3", name: "browser__extract", input: { selector: "#a" } },
        ],
      },
      { type: "tool_result", toolUseId: "t0", tool: "browser__cache_read", isError: false, content: [] },
      { type: "tool_result", toolUseId: "t1", tool: "browser__snapshot", isError: false, content: [] },
      { type: "tool_result", toolUseId: "t2", tool: "browser__fill", isError: false, content: [] },
      { type: "tool_result", toolUseId: "t3", tool: "browser__extract", isError: false, content: [] },
      { type: "verification", tool: "browser__eval", args: { expression: "1" }, expectPattern: "1", matched: true },
      { type: "finish_task", status: "success" },
    ];
    const { steps } = extractTrajectory(events);
    expect(steps.map((s) => s.tool)).toEqual(["browser__fill"]);
  });

  it("lifts locator suffixes in tool results into step.locator", () => {
    const events = [
      {
        type: "model_response",
        toolUses: [{ id: "t1", name: "browser__fill", input: { selector: "#sku", value: "901384900" } }],
      },
      {
        type: "tool_result",
        toolUseId: "t1",
        tool: "browser__fill",
        isError: false,
        content: [{ type: "text", text: 'Filled #sku with "901384900" [target: textbox "Search products"]' }],
      },
      { type: "verification", tool: "browser__eval", args: { expression: "1" }, expectPattern: "1", matched: true },
      { type: "finish_task", status: "success" },
    ];
    const { steps } = extractTrajectory(events);
    expect(steps[0]!.locator).toEqual({ role: "textbox", name: "Search products" });
  });
});

describe("parameterization", () => {
  it("detects only value-like literals shared between task and args", () => {
    const { steps, postCondition } = extractTrajectory(fixtureEvents);
    const literals = detectLiterals(TASK, steps, postCondition);
    // Longest-first; the attribute word "EAN" is intentionally NOT parameterized.
    expect(literals).toEqual(["1234567890999", "901384900"]);
  });

  it("substitutes every occurrence with the named placeholder, including in locators", () => {
    const mapping = buildMapping({ "901384900": "sku", "1234567890999": "ean" });
    const step = parameterizeStep(
      {
        tool: "browser__click_text",
        args: { text: "901384900" },
        locator: { role: "row", name: "901384900SimplePasta..." },
      },
      mapping,
    );
    expect(step.args.text).toBe("{{sku}}");
    expect(step.locator?.name).toBe("{{sku}}SimplePasta...");
    expect((step as unknown as Record<string, unknown>).resultText).toBeUndefined();

    const post = parameterizePostCondition(
      { tool: "browser__eval", args: { expression: "q('input').value" }, expectPattern: "1234567890999" },
      mapping,
    );
    expect(post.expectPattern).toBe("{{ean}}");
  });
});

describe("segmentation validation", () => {
  const base: Segmentation = {
    flowName: "set_ean_for_product",
    flowDescription: "x",
    paramNames: { "901384900": "sku", "1234567890999": "ean" },
    segments: [
      {
        name: "open_product_by_sku",
        description: "x",
        firstStep: 0,
        lastStep: 4,
        postCondition: { tool: "browser__eval", args: { expression: "!!document.querySelector('x')" }, expectPattern: "true" },
      },
      { name: "set_ean", description: "x", firstStep: 5, lastStep: 7 },
    ],
    playbookNotes: [],
  };
  const LITERALS = ["1234567890999", "901384900"];

  it("accepts a contiguous, well-formed segmentation", () => {
    expect(() => validateSegmentation(base, 8, LITERALS)).not.toThrow();
  });

  it("rejects gaps, overlaps, and out-of-range segments", () => {
    const gap = { ...base, segments: [{ ...base.segments[0]! }, { ...base.segments[1]!, firstStep: 6 }] };
    expect(() => validateSegmentation(gap, 8, LITERALS)).toThrow(/contiguously/);
    const short = { ...base, segments: [base.segments[0]!] };
    expect(() => validateSegmentation(short, 8, LITERALS)).toThrow(/cover/);
    const over = { ...base, segments: [base.segments[0]!, { ...base.segments[1]!, lastStep: 9 }] };
    expect(() => validateSegmentation(over, 8, LITERALS)).toThrow(/invalid range/);
  });

  it("rejects paramNames keys that are not detected literals (trust boundary)", () => {
    const rogue = { ...base, paramNames: { ...base.paramNames, akeneo: "system" } };
    expect(() => validateSegmentation(rogue, 8, LITERALS)).toThrow(/not a detected literal/);
  });

  it("rejects non-final segments without a read-only post-condition", () => {
    const missing = { ...base, segments: [{ ...base.segments[0]!, postCondition: undefined }, base.segments[1]!] };
    expect(() => validateSegmentation(missing, 8, LITERALS)).toThrow(/no post-condition/);
    const mutating = {
      ...base,
      segments: [
        { ...base.segments[0]!, postCondition: { tool: "browser__click", args: {}, expectPattern: "x" } },
        base.segments[1]!,
      ],
    };
    expect(() => validateSegmentation(mutating, 8, LITERALS)).toThrow(/read-only/);
  });
});

describe("compileRun", () => {
  const twoSegmentSegmenter: Segmenter = async () => ({
    flowName: "set_ean_for_product",
    flowDescription: "Open an Akeneo product by SKU and set its EAN attribute.",
    paramNames: { "901384900": "sku", "1234567890999": "ean" },
    segments: [
      {
        name: "open_product_by_sku",
        description: "Open a product's edit page by searching its SKU in the grid.",
        firstStep: 0,
        lastStep: 4,
        postCondition: {
          tool: "browser__eval",
          args: { expression: "!!document.querySelector('input[placeholder=\"Search attributes by label or code\"]')" },
          expectPattern: "true",
        },
      },
      {
        name: "set_ean",
        description: "Set the EAN attribute on the open product and save.",
        firstStep: 5,
        lastStep: 7,
      },
    ],
    playbookNotes: ["Product grid search fires only on Enter, not on input."],
  });

  it("segments into primitives + a flow (acceptance: open_product_by_sku with sku param)", async () => {
    const result = await compileRun({
      events: fixtureEvents,
      runId: "test-run",
      task: TASK,
      model: "test-model",
      client: "opari",
      metaStatus: "success",
      segmenter: twoSegmentSegmenter,
    });

    expect(result.fallbackReason).toBeUndefined();
    expect(result.primitives.map((p) => p.name)).toEqual(["open_product_by_sku", "set_ean"]);

    const open = result.primitives[0]!;
    expect(open.kind).toBe("primitive");
    expect(open.client).toBe("opari");
    expect(open.steps.length).toBe(5);
    expect(open.params).toEqual([{ name: "sku", example: "901384900" }]); // ean is NOT in scope here
    expect(JSON.stringify(open.steps)).toContain("{{sku}}");
    expect(open.postCondition.expectPattern).toBe("true"); // synthesized, not run-specific

    const set = result.primitives[1]!;
    expect(set.steps.length).toBe(3);
    expect(set.params).toEqual([{ name: "ean", example: "1234567890999" }]);
    expect(set.postCondition.expectPattern).toBe("{{ean}}"); // run's verified post-condition

    expect(result.flow).not.toBeNull();
    expect(result.flow!.name).toBe("set_ean_for_product");
    expect(result.flow!.calls).toEqual([
      { skill: "open_product_by_sku", params: { sku: "{{sku}}" } },
      { skill: "set_ean", params: { ean: "{{ean}}" } },
    ]);
    expect(result.flow!.params.map((p) => p.name).sort()).toEqual(["ean", "sku"]);
    expect(result.playbookNotes).toEqual(["Product grid search fires only on Enter, not on input."]);
  });

  it("stamps every compiled skill with an explored lineage root", async () => {
    const result = await compileRun({
      events: fixtureEvents,
      runId: "test-run",
      task: TASK,
      model: "test-model",
      client: "opari",
      metaStatus: "success",
      segmenter: twoSegmentSegmenter,
    });

    for (const skill of [...result.primitives, result.flow!]) {
      expect(skill.lineage).toHaveLength(1);
      const root = skill.lineage![0]!;
      expect(root.type).toBe("explored");
      expect(root.runId).toBe("test-run");
      expect(root.note).toContain("test-run");
      expect(healCount(skill.lineage)).toBe(0); // a fresh skill has no scar tissue
    }
  });

  it("falls back to a monolith when the segmentation is invalid (rogue paramNames)", async () => {
    const rogueSegmenter: Segmenter = async (input) => {
      const seg = await twoSegmentSegmenter(input);
      return { ...seg, paramNames: { ...seg.paramNames, akeneo: "system" } };
    };
    const result = await compileRun({
      events: fixtureEvents,
      runId: "r",
      task: TASK,
      model: "m",
      metaStatus: "success",
      segmenter: rogueSegmenter,
    });

    expect(result.fallbackReason).toMatch(/not a detected literal/);
    expect(result.primitives.length).toBe(1);
    expect(result.flow).toBeNull();
    const only = result.primitives[0]!;
    expect(only.steps.length).toBe(8);
    // No corruption: URLs intact, no phantom placeholders.
    const json = JSON.stringify(only.steps);
    expect(json).toContain("akeneo.com");
    expect(json).not.toContain("{{system}}");
  });

  it("refuses to compile a run that did not succeed", async () => {
    await expect(
      compileRun({ events: fixtureEvents, runId: "r", task: TASK, model: "m", metaStatus: "halted", segmenter: monolithSegmenter }),
    ).rejects.toThrow(CompileError);
  });

  it("monolith segmenter yields one skill, positional params, no digits in the name", async () => {
    const result = await compileRun({
      events: fixtureEvents,
      runId: "r",
      task: TASK,
      model: "m",
      metaStatus: "success",
      segmenter: monolithSegmenter,
    });
    expect(result.primitives.length).toBe(1);
    expect(result.flow).toBeNull();
    const skill = result.primitives[0]!;
    expect(skill.name).toMatch(/^in_akeneo/);
    expect(skill.name).not.toMatch(/\d/);
    expect(skill.params.map((p) => p.name).sort()).toEqual(["param1", "param2"]);
  });
});
