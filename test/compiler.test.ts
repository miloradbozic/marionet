import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEvents, extractTrajectory, assertCompilable, CompileError } from "../src/compiler/trajectory.js";
import { detectLiterals, parameterize } from "../src/compiler/parameterize.js";
import { compileRun, heuristicNamer, type Namer } from "../src/compiler/compile.js";

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
  });

  it("assertCompilable accepts a verified success and rejects otherwise", () => {
    expect(() => assertCompilable(fixtureEvents, "success")).not.toThrow();
    expect(() => assertCompilable(fixtureEvents, "failure")).toThrow(CompileError);
    expect(() => assertCompilable([{ type: "finish_task", status: "success" }], "success")).toThrow(/verification/);
  });
});

describe("parameterization", () => {
  it("detects only value-like literals shared between task and args", () => {
    const { steps, postCondition } = extractTrajectory(fixtureEvents);
    const literals = detectLiterals(TASK, steps, postCondition);
    // Longest-first; the attribute word "EAN" is intentionally NOT parameterized.
    expect(literals).toEqual(["1234567890999", "901384900"]);
  });

  it("substitutes every occurrence with the named placeholder", () => {
    const { steps, postCondition } = extractTrajectory(fixtureEvents);
    const result = parameterize(steps, postCondition, { "901384900": "sku", "1234567890999": "ean" });

    const fillSku = result.steps.find((s) => s.tool === "browser__fill" && String(s.args.selector).includes("label, identifier"));
    expect(fillSku?.args.value).toBe("{{sku}}");
    const clickText = result.steps.find((s) => s.tool === "browser__click_text");
    expect(clickText?.args.text).toBe("{{sku}}");
    const fillEan = result.steps.find((s) => s.tool === "browser__fill" && String(s.args.selector).includes("product-value-field-ean-"));
    expect(fillEan?.args.value).toBe("{{ean}}");
    expect(result.postCondition.expectPattern).toBe("{{ean}}");
  });
});

describe("compileRun", () => {
  const stubNamer: Namer = async () => ({
    skillName: "open_product_by_sku",
    description: "Open an Akeneo product by SKU and set its EAN attribute.",
    paramNames: { "901384900": "sku", "1234567890999": "ean" },
  });

  it("produces a parameterized, verifiable skill (acceptance: sku parameterized)", async () => {
    const skill = await compileRun({
      events: fixtureEvents,
      runId: "test-run",
      task: TASK,
      model: "test-model",
      client: "opari",
      metaStatus: "success",
      namer: stubNamer,
    });

    expect(skill.name).toBe("open_product_by_sku");
    expect(skill.client).toBe("opari");
    expect(skill.params.find((p) => p.name === "sku")?.example).toBe("901384900");
    expect(skill.params.find((p) => p.name === "ean")?.example).toBe("1234567890999");
    expect(skill.steps.length).toBe(8);
    expect(JSON.stringify(skill.steps)).toContain("{{sku}}");
    expect(JSON.stringify(skill.steps)).toContain("{{ean}}");
    expect(skill.postCondition.expectPattern).toBe("{{ean}}");
    expect(skill.source.runId).toBe("test-run");
  });

  it("refuses to compile a run that did not succeed", async () => {
    await expect(
      compileRun({ events: fixtureEvents, runId: "r", task: TASK, model: "m", metaStatus: "halted", namer: stubNamer }),
    ).rejects.toThrow(CompileError);
  });

  it("heuristic namer yields positional params and a task-derived name", async () => {
    const skill = await compileRun({
      events: fixtureEvents,
      runId: "r",
      task: TASK,
      model: "m",
      metaStatus: "success",
      namer: heuristicNamer,
    });
    expect(skill.name).toMatch(/^in_akeneo/);
    expect(skill.params.map((p) => p.name).sort()).toEqual(["param1", "param2"]);
  });
});
