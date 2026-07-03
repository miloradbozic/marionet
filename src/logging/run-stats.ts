import { readFileSync } from "node:fs";
import path from "node:path";
import type { RunMeta } from "./run-logger.js";
import { parseEvents } from "../compiler/trajectory.js";
import { estimateCostUsd } from "../llm-client.js";

/**
 * Answers "what did this run cost me?" from the logs alone: duration, LLM
 * turns, tokens, estimated cost, and whether the work was done by replay
 * (run_skill / the replay command) or by the model step-by-step. Works on any
 * run dir, including killed runs (falls back to the last event timestamp).
 */

export interface RunStats {
  runId: string;
  task: string;
  client?: string;
  model: string;
  status: string;
  durationMs: number;
  /** Model API calls made by this run (exploration turns + heal calls). */
  llmTurns: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated from pricing snapshotted in meta.json (fallback: passed-in pricing); undefined when neither exists. */
  costUsd?: number;
  replay?: {
    /** "run_skill" when the exploration agent invoked a skill; "replay" for the CLI command. */
    via: "run_skill" | "replay";
    skills: string[];
    steps: number;
    heals: number;
  };
}

export function computeRunStats(runDir: string, fallbackPricing?: { input: number; output: number }): RunStats {
  const meta = JSON.parse(readFileSync(path.join(runDir, "meta.json"), "utf-8")) as RunMeta;
  const events = parseEvents(readFileSync(path.join(runDir, "events.jsonl"), "utf-8"));

  let llmTurns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let usedRunSkill = false;
  const replaySkills: string[] = [];
  let replaySteps = 0;
  let replayHeals = 0;
  let lastTs = meta.startedAt;

  for (const e of events as Array<Record<string, unknown>>) {
    if (typeof e.ts === "string") lastTs = e.ts;
    if (e.type === "model_response") {
      llmTurns++;
      const usage = e.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      inputTokens += usage?.input_tokens ?? 0;
      outputTokens += usage?.output_tokens ?? 0;
      const toolUses = e.toolUses as Array<{ name?: string }> | undefined;
      if (toolUses?.some((t) => t.name === "run_skill")) usedRunSkill = true;
    }
    if (e.type === "replay_finish") {
      replaySkills.push(...((e.primitivesRun as string[] | undefined) ?? []));
      replaySteps += (e.stepsExecuted as number | undefined) ?? 0;
      replayHeals += (e.healsApplied as number | undefined) ?? 0;
    }
  }

  const pricing = meta.pricing ?? fallbackPricing;
  const endedAt = meta.endedAt ?? lastTs;
  return {
    runId: meta.runId,
    task: meta.task,
    ...(meta.client ? { client: meta.client } : {}),
    model: meta.model,
    status: meta.status ?? "unknown (killed?)",
    durationMs: new Date(endedAt).getTime() - new Date(meta.startedAt).getTime(),
    llmTurns,
    inputTokens,
    outputTokens,
    ...(pricing ? { costUsd: estimateCostUsd(inputTokens, outputTokens, pricing) } : {}),
    ...(replaySkills.length
      ? { replay: { via: usedRunSkill ? ("run_skill" as const) : ("replay" as const), skills: replaySkills, steps: replaySteps, heals: replayHeals } }
      : {}),
  };
}

export function renderRunStats(s: RunStats): string {
  const secs = (s.durationMs / 1000).toFixed(1);
  const cost = s.costUsd !== undefined ? `$${s.costUsd.toFixed(4)}` : "n/a (no pricing in meta or config)";
  const replay = s.replay
    ? `yes, via ${s.replay.via}: ${s.replay.skills.join(" -> ")} (${s.replay.steps} steps, ${s.replay.heals} heal(s))`
    : "no (model drove every step)";
  return [
    `run:      ${s.runId}`,
    `task:     ${s.task}`,
    `status:   ${s.status}`,
    `duration: ${secs}s`,
    `llm:      ${s.llmTurns} turn(s), ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out tokens`,
    `cost:     ${cost}`,
    `replay:   ${replay}`,
  ].join("\n");
}
