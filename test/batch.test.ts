import { describe, expect, it, vi } from "vitest";
import { runBatch, type BatchRowResult } from "../src/replay/batch.js";

const ok = (): BatchRowResult => ({ status: "success", summary: "ok" });
const bad = (): BatchRowResult => ({ status: "failure", summary: "nope" });

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ sku: String(i) }));

describe("runBatch", () => {
  it("runs every row when they all pass", async () => {
    const runOne = vi.fn(async () => ok());
    const r = await runBatch({ rows: rows(5), runOne });
    expect(r).toMatchObject({ attempted: 5, succeeded: 5, failed: 0, abandoned: 0 });
    expect(r.trippedAfter).toBeUndefined();
    expect(runOne).toHaveBeenCalledTimes(5);
  });

  it("continues past scattered row-local failures without tripping", async () => {
    // Bad SKUs at 1 and 3, good ones between: the fault is about the row, so
    // the batch must see every row.
    const runOne = vi.fn(async (_row, i: number) => (i === 1 || i === 3 ? bad() : ok()));
    const r = await runBatch({ rows: rows(6), runOne });
    expect(r).toMatchObject({ attempted: 6, succeeded: 4, failed: 2, abandoned: 0 });
    expect(r.trippedAfter).toBeUndefined();
  });

  it("stops the batch when failures run consecutively (the dead-session case)", async () => {
    // The session dies at row 2 and never comes back.
    const runOne = vi.fn(async (_row, i: number) => (i >= 2 ? bad() : ok()));
    const onTrip = vi.fn();
    const r = await runBatch({ rows: rows(300), runOne, onTrip });

    expect(r.trippedAfter).toBe(3);
    expect(r.attempted).toBe(5); // rows 0-1 passed, 2-4 failed, then it stopped
    expect(r.abandoned).toBe(295); // ...instead of burning a heal budget on each
    expect(runOne).toHaveBeenCalledTimes(5);
    expect(onTrip).toHaveBeenCalledOnce();
  });

  it("resets the run on any success, so a near-miss never trips it", async () => {
    // Two failures, a success, two more failures: never 3 in a row.
    const script = [bad(), bad(), ok(), bad(), bad()];
    const runOne = vi.fn(async (_row, i: number) => script[i]!);
    const r = await runBatch({ rows: rows(5), runOne });
    expect(r.trippedAfter).toBeUndefined();
    expect(r).toMatchObject({ attempted: 5, succeeded: 1, failed: 4 });
  });

  it("counts a blocked row as a failure (policy denial is systemic, not row-local)", async () => {
    const runOne = vi.fn(async () => ({ status: "blocked" as const, summary: "denied by policy" }));
    const r = await runBatch({ rows: rows(10), runOne });
    expect(r.trippedAfter).toBe(3);
    expect(r.attempted).toBe(3);
  });

  it("honours a custom threshold", async () => {
    const runOne = vi.fn(async () => bad());
    const r = await runBatch({ rows: rows(10), runOne, maxConsecutiveFailures: 1 });
    expect(r.trippedAfter).toBe(1);
    expect(r.attempted).toBe(1);
    expect(r.abandoned).toBe(9);
  });

  it("never trips on a single-row run: it has nothing to protect", async () => {
    const runOne = vi.fn(async () => bad());
    const r = await runBatch({ rows: rows(1), runOne, maxConsecutiveFailures: 1 });
    expect(r.trippedAfter).toBeUndefined();
    expect(r).toMatchObject({ attempted: 1, failed: 1, abandoned: 0 });
  });

  it("reports progress per row", async () => {
    const onRowStart = vi.fn();
    const onRowEnd = vi.fn();
    await runBatch({ rows: rows(2), runOne: async () => ok(), onRowStart, onRowEnd });
    expect(onRowStart).toHaveBeenCalledTimes(2);
    expect(onRowEnd).toHaveBeenCalledTimes(2);
    expect(onRowStart).toHaveBeenLastCalledWith({ sku: "1" }, 1, 2);
  });
});
