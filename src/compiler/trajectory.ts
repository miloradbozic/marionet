import type { SkillPostCondition, SkillStep } from "./skill.types.js";

/** A single parsed line from events.jsonl (loose by design -- events are heterogeneous). */
export type RunEvent = Record<string, unknown> & { type?: string };

export function parseEvents(jsonl: string): RunEvent[] {
  return jsonl
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunEvent);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface ExtractedTrajectory {
  /** Successfully-executed, non-finish tool calls, in order. */
  steps: SkillStep[];
  /** The verification the run passed, lifted into a post-condition. */
  postCondition: SkillPostCondition;
}

export class CompileError extends Error {}

/**
 * Reduces a run's events into the executed steps + post-condition. Only
 * meaningful for a successful, verified run -- call `assertCompilable` first.
 *
 * - Steps are tool calls whose tool_result was not an error (finish_task and
 *   denied/errored calls are excluded).
 * - The post-condition is the matched `verification` event.
 * - If the final step duplicates the verification (the model often re-reads the
 *   same value right before finishing), it's dropped so the skill doesn't do
 *   redundant work.
 */
export function extractTrajectory(events: RunEvent[]): ExtractedTrajectory {
  const inputById = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const e of events) {
    if (e.type === "model_response" && Array.isArray(e.toolUses)) {
      for (const tu of e.toolUses as Array<{ id?: string; name?: string; input?: Record<string, unknown> }>) {
        if (tu.id && tu.name) inputById.set(tu.id, { name: tu.name, input: tu.input ?? {} });
      }
    }
  }

  const steps: SkillStep[] = [];
  for (const e of events) {
    if (e.type !== "tool_result") continue;
    if (e.isError) continue;
    const id = e.toolUseId as string | undefined;
    const call = id ? inputById.get(id) : undefined;
    const name = (call?.name ?? (e.tool as string | undefined)) ?? undefined;
    if (!name || name === "finish_task") continue;
    steps.push({ tool: name, args: call?.input ?? {} });
  }

  const verification = [...events].reverse().find((e) => e.type === "verification" && e.matched === true);
  if (!verification) {
    throw new CompileError("Run has no passing verification event; cannot derive a post-condition.");
  }
  const postCondition: SkillPostCondition = {
    tool: verification.tool as string,
    args: (verification.args as Record<string, unknown>) ?? {},
    expectPattern: verification.expectPattern as string,
  };

  const last = steps.at(-1);
  if (last && last.tool === postCondition.tool && deepEqual(last.args, postCondition.args)) {
    steps.pop();
  }

  if (steps.length === 0) {
    throw new CompileError("Run produced no executable steps.");
  }

  return { steps, postCondition };
}

/**
 * Guards compilation: a skill is only trustworthy if the run actually finished
 * "success" and passed an independent verification.
 */
export function assertCompilable(events: RunEvent[], metaStatus: string | undefined): void {
  if (metaStatus && metaStatus !== "success") {
    throw new CompileError(`Run status is "${metaStatus}", not "success" -- only verified successful runs compile into skills.`);
  }
  const finish = [...events].reverse().find((e) => e.type === "finish_task");
  if (!finish) throw new CompileError("Run never called finish_task.");
  if (finish.status !== "success") {
    throw new CompileError(`finish_task status is "${String(finish.status)}", not "success".`);
  }
  const passed = events.some((e) => e.type === "verification" && e.matched === true);
  if (!passed) throw new CompileError("Run did not pass verification.");
}
