import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";

/**
 * Batch resume (`--resume`, the checkpointed slice of P17): re-running a
 * partially failed CSV must not re-submit the rows that already succeeded.
 *
 * The bookkeeping is row-level and comes from the previous run's events.jsonl:
 * a row counts as done if its replay ended in a verified success back then, or
 * if that run itself resumed past it. This is deliberately NOT world-state
 * reconstruction from the log -- each skipped row was world-verified by its
 * own post-condition at the moment it ran; the log only remembers *which rows*
 * that was true for. The alternative (probing the world per row before
 * running it) sounds purer but fails in practice: most compiled
 * post-conditions are page-local ("this product's EAN field shows X"), so
 * checking row 214 would require navigating to row 214 first -- the very work
 * being skipped.
 *
 * Trust window: the verification is as old as the previous run. For the
 * scenario this exists for -- the breaker tripped or the run crashed minutes
 * ago and the operator is re-running -- that is exactly right. It is not a
 * mechanism for reconciling week-old batches against a changed world.
 */

export interface ResumeSource {
  runId: string;
  runDir: string;
  /** Canonical param-JSON of every row that run verified as done. */
  doneRows: Set<string>;
}

/** Stable identity for a row: its params with sorted keys. */
export function canonicalRow(params: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))));
}

interface RunEventLine {
  type?: string;
  skill?: string;
  params?: Record<string, string>;
  status?: string;
}

/**
 * Rows a finished-or-dead batch run proved done. Pairs each `replay_start`
 * with the next `replay_finish` (replays are strictly sequential within a
 * run), and also honors `row_skipped_resume` markers so resuming from a run
 * that itself resumed still counts the rows the chain verified earlier.
 */
export function collectDoneRows(runDir: string, skillName: string): Set<string> {
  const done = new Set<string>();
  const eventsPath = path.join(runDir, "events.jsonl");
  if (!existsSync(eventsPath)) return done;

  let pending: string | null = null;
  for (const line of readFileSync(eventsPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let e: RunEventLine;
    try {
      e = JSON.parse(line) as RunEventLine;
    } catch {
      continue; // a torn last line from a crash is expected, not an error
    }
    if (e.type === "replay_start" && e.skill === skillName && e.params) {
      pending = canonicalRow(e.params);
    } else if (e.type === "replay_finish" && pending !== null) {
      if (e.status === "success") done.add(pending);
      pending = null;
    } else if (e.type === "row_skipped_resume" && e.params) {
      done.add(canonicalRow(e.params));
    }
  }
  return done;
}

interface RunMeta {
  task?: string;
  status?: string;
}

/**
 * The most recent batch run of this skill (matched on the task line the
 * replay command writes), whatever its status -- the interesting case is
 * precisely the run that failed or was killed partway.
 */
export function findLatestBatchRun(runsRoot: string, skillName: string): ResumeSource | null {
  if (!existsSync(runsRoot)) return null;
  const prefix = `replay ${skillName} --csv`;
  // Run ids are timestamp-prefixed, so lexicographic order is chronological.
  const runIds = readdirSync(runsRoot).sort().reverse();
  for (const runId of runIds) {
    const runDir = path.join(runsRoot, runId);
    const metaPath = path.join(runDir, "meta.json");
    if (!existsSync(metaPath)) continue;
    let meta: RunMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf-8")) as RunMeta;
    } catch {
      continue;
    }
    if (!meta.task?.startsWith(prefix)) continue;
    return { runId, runDir, doneRows: collectDoneRows(runDir, skillName) };
  }
  return null;
}

export interface ResumePlan {
  source: ResumeSource;
  /** Rows still to run, in original order. */
  todo: Array<Record<string, string>>;
  /** Rows verified done by the previous run, skipped now. */
  skipped: Array<Record<string, string>>;
}

/**
 * Partition the batch against the previous run's bookkeeping. For a flow, the
 * done-row markers were written for the flow's own replay_start, so the skill
 * name must match what the operator replays -- resuming skill A from a run of
 * skill B is refused upstream by the task-line match in findLatestBatchRun.
 */
export function planResume(source: ResumeSource, rows: Array<Record<string, string>>): ResumePlan {
  const todo: Array<Record<string, string>> = [];
  const skipped: Array<Record<string, string>> = [];
  for (const row of rows) {
    (source.doneRows.has(canonicalRow(row)) ? skipped : todo).push(row);
  }
  return { source, todo, skipped };
}
