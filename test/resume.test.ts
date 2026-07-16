import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalRow, collectDoneRows, findLatestBatchRun, planResume } from "../src/replay/resume.js";

/**
 * The scenario --resume exists for: a 5-row batch died partway (breaker or
 * crash), the operator re-runs it, and the rows that were already VERIFIED
 * done must not be re-submitted.
 */

function makeRun(runsRoot: string, runId: string, task: string, eventLines: Array<Record<string, unknown>>, torn = false): string {
  const runDir = path.join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "meta.json"), JSON.stringify({ runId, task, status: "failure" }));
  let body = eventLines.map((e) => JSON.stringify(e)).join("\n") + "\n";
  if (torn) body += '{"type":"replay_step","tool":"browser__cl'; // crash mid-write
  writeFileSync(path.join(runDir, "events.jsonl"), body);
  return runDir;
}

const row = (sku: string) => ({ sku, ean: `ean-${sku}` });

function batchEvents(skill: string, results: Array<{ params: Record<string, string>; status: string }>): Array<Record<string, unknown>> {
  return results.flatMap(({ params, status }) => [
    { type: "replay_start", skill, params, plan: [skill] },
    { type: "replay_step", context: `${skill}[0]`, tool: "browser__fill" },
    { type: "replay_finish", status, summary: "" },
  ]);
}

describe("collectDoneRows", () => {
  it("collects only rows whose replay finished success, surviving a torn log tail", () => {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), "marionet-resume-"));
    const runDir = makeRun(
      runsRoot,
      "2026-07-15T10-00-00-000Z-abc",
      "replay set_ean --csv rows.csv (5 rows)",
      batchEvents("set_ean", [
        { params: row("1"), status: "success" },
        { params: row("2"), status: "success" },
        { params: row("3"), status: "failure" },
      ]),
      true, // the run died writing row 4's events
    );

    const done = collectDoneRows(runDir, "set_ean");
    expect(done).toEqual(new Set([canonicalRow(row("1")), canonicalRow(row("2"))]));
  });

  it("treats param key order as irrelevant to row identity", () => {
    expect(canonicalRow({ b: "2", a: "1" })).toBe(canonicalRow({ a: "1", b: "2" }));
  });

  it("counts rows the previous run itself resume-skipped (chained resume)", () => {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), "marionet-resume-"));
    const runDir = makeRun(runsRoot, "2026-07-15T11-00-00-000Z-def", "replay set_ean --csv rows.csv (3 rows)", [
      { type: "row_skipped_resume", params: row("1"), verifiedInRun: "earlier" },
      ...batchEvents("set_ean", [{ params: row("2"), status: "success" }]),
    ]);

    const done = collectDoneRows(runDir, "set_ean");
    expect(done.has(canonicalRow(row("1")))).toBe(true); // inherited
    expect(done.has(canonicalRow(row("2")))).toBe(true); // fresh
  });

  it("ignores replays of other skills inside the same run", () => {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), "marionet-resume-"));
    const runDir = makeRun(runsRoot, "2026-07-15T12-00-00-000Z-ghi", "replay set_ean --csv rows.csv (1 rows)",
      batchEvents("other_skill", [{ params: row("9"), status: "success" }]));
    expect(collectDoneRows(runDir, "set_ean").size).toBe(0);
  });
});

describe("findLatestBatchRun", () => {
  it("finds the most recent batch run of the right skill, skipping other tasks", () => {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), "marionet-resume-"));
    makeRun(runsRoot, "2026-07-15T10-00-00-000Z-old", "replay set_ean --csv rows.csv (5 rows)",
      batchEvents("set_ean", [{ params: row("1"), status: "success" }]));
    makeRun(runsRoot, "2026-07-15T11-00-00-000Z-oth", "replay other_skill --csv x.csv (2 rows)",
      batchEvents("other_skill", [{ params: row("8"), status: "success" }]));
    makeRun(runsRoot, "2026-07-15T12-00-00-000Z-new", "replay set_ean --csv rows.csv (5 rows)",
      batchEvents("set_ean", [{ params: row("2"), status: "success" }]));
    // An exploration run must never match, even if it mentions the skill.
    makeRun(runsRoot, "2026-07-15T13-00-00-000Z-exp", "use set_ean to fix products", []);

    const source = findLatestBatchRun(runsRoot, "set_ean");
    expect(source!.runId).toBe("2026-07-15T12-00-00-000Z-new");
    expect(source!.doneRows.has(canonicalRow(row("2")))).toBe(true);
    expect(source!.doneRows.has(canonicalRow(row("1")))).toBe(false); // only the latest run counts
  });

  it("returns null when no batch run of this skill exists", () => {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), "marionet-resume-"));
    expect(findLatestBatchRun(runsRoot, "set_ean")).toBeNull();
    expect(findLatestBatchRun(path.join(runsRoot, "missing"), "set_ean")).toBeNull();
  });
});

describe("planResume", () => {
  it("partitions rows into done and todo, preserving order", () => {
    const source = {
      runId: "r",
      runDir: "/x",
      doneRows: new Set([canonicalRow(row("1")), canonicalRow(row("3"))]),
    };
    const rows = [row("1"), row("2"), row("3"), row("4")];
    const plan = planResume(source, rows);
    expect(plan.skipped).toEqual([row("1"), row("3")]);
    expect(plan.todo).toEqual([row("2"), row("4")]);
  });

  it("a changed param value makes it a different row (no false skip)", () => {
    // Same SKU, different EAN: the operator fixed the CSV -- this row must RUN.
    const source = { runId: "r", runDir: "/x", doneRows: new Set([canonicalRow({ sku: "1", ean: "old" })]) };
    const plan = planResume(source, [{ sku: "1", ean: "corrected" }]);
    expect(plan.todo).toHaveLength(1);
    expect(plan.skipped).toHaveLength(0);
  });
});
