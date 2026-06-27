import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PolicyConfig } from "../policy/policy.types.js";

export interface RunMeta {
  runId: string;
  task: string;
  model: string;
  maxTurns: number;
  maxCostUsd: number;
  policySnapshot: PolicyConfig;
  policySourcePath: string;
  startedAt: string;
  endedAt?: string;
  status?: string;
}

/**
 * events.jsonl is the append-only source of truth: one JSON line per
 * loggable event, flushed synchronously, so a killed/crashed run still
 * leaves a valid, readable partial log. meta.json snapshots the policy as it
 * was *at run time* since policy.json5 is editable and a past run's gating
 * decisions need to stay explicable even after the file changes.
 */
export class RunLogger {
  readonly runDir: string;
  readonly runId: string;
  private readonly eventsPath: string;
  private readonly metaPath: string;
  private meta: RunMeta;
  private iter = 0;

  constructor(
    runsRoot: string,
    opts: {
      task: string;
      model: string;
      maxTurns: number;
      maxCostUsd: number;
      policySnapshot: PolicyConfig;
      policySourcePath: string;
    },
  ) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const shortId = Math.random().toString(36).slice(2, 8);
    this.runId = `${ts}-${shortId}`;
    this.runDir = path.join(runsRoot, this.runId);
    mkdirSync(this.runDir, { recursive: true });
    this.eventsPath = path.join(this.runDir, "events.jsonl");
    this.metaPath = path.join(this.runDir, "meta.json");
    this.meta = {
      runId: this.runId,
      task: opts.task,
      model: opts.model,
      maxTurns: opts.maxTurns,
      maxCostUsd: opts.maxCostUsd,
      policySnapshot: opts.policySnapshot,
      policySourcePath: opts.policySourcePath,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(this.metaPath, JSON.stringify(this.meta, null, 2));
  }

  setIter(iter: number): void {
    this.iter = iter;
  }

  log(event: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), iter: this.iter, ...event });
    appendFileSync(this.eventsPath, line + "\n");
  }

  finalize(status: string): void {
    this.meta.endedAt = new Date().toISOString();
    this.meta.status = status;
    writeFileSync(this.metaPath, JSON.stringify(this.meta, null, 2));
  }
}
