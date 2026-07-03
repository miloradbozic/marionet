import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeRunStats } from "../src/logging/run-stats.js";

function writeRun(events: Array<Record<string, unknown>>, meta: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "marionet-stats-"));
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
}

const baseMeta = {
  runId: "r1",
  task: "set the EAN",
  model: "m",
  maxTurns: 40,
  maxCostUsd: 1,
  policySnapshot: { rules: [] },
  policySourcePath: "p",
  startedAt: "2026-07-03T10:00:00.000Z",
  endedAt: "2026-07-03T10:00:40.000Z",
  status: "success",
};

describe("computeRunStats", () => {
  it("sums turns/tokens, prices from the meta snapshot, and spots run_skill replays", () => {
    const dir = writeRun(
      [
        { ts: "2026-07-03T10:00:01.000Z", type: "model_response", usage: { input_tokens: 1000, output_tokens: 100 }, toolUses: [{ name: "run_skill" }] },
        { ts: "2026-07-03T10:00:20.000Z", type: "replay_finish", status: "success", stepsExecuted: 10, healsApplied: 1, primitivesRun: ["a", "b"] },
        { ts: "2026-07-03T10:00:39.000Z", type: "model_response", usage: { input_tokens: 2000, output_tokens: 200 }, toolUses: [{ name: "finish_task" }] },
      ],
      { ...baseMeta, pricing: { input: 1, output: 10 } },
    );
    const s = computeRunStats(dir);
    expect(s.durationMs).toBe(40_000);
    expect(s.llmTurns).toBe(2);
    expect(s.inputTokens).toBe(3000);
    expect(s.outputTokens).toBe(300);
    expect(s.costUsd).toBeCloseTo(0.003 + 0.003, 6);
    expect(s.replay).toEqual({ via: "run_skill", skills: ["a", "b"], steps: 10, heals: 1 });
  });

  it("handles killed runs (no endedAt) and runs with no pricing anywhere", () => {
    const dir = writeRun(
      [{ ts: "2026-07-03T10:00:30.000Z", type: "model_response", usage: { input_tokens: 10, output_tokens: 1 } }],
      { ...baseMeta, endedAt: undefined, status: undefined },
    );
    const s = computeRunStats(dir);
    expect(s.durationMs).toBe(30_000); // falls back to the last event timestamp
    expect(s.status).toContain("unknown");
    expect(s.costUsd).toBeUndefined();
    expect(s.replay).toBeUndefined();
  });
});
