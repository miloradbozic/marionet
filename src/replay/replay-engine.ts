import type { McpClientManager, McpToolResult } from "../mcp/mcp-client-manager.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import type { RunLogger } from "../logging/run-logger.js";
import { confirmToolCall } from "../confirm/cli-prompt.js";
import { isFlowSkill, type Skill, type SkillStep } from "../compiler/skill.types.js";
import { ParamError, substituteArgs, substitutePattern, substituteString } from "./params.js";
import type { SkillStore } from "./skill-store.js";
import type { Healer } from "./heal.js";

/**
 * Replay engine: executes a compiled skill deterministically -- zero LLM calls
 * on the happy path, milliseconds of orchestration per step. Flows expand into
 * their primitive skills; each primitive ends with its post-condition check.
 *
 * Every step still goes through the policy engine (a replayed action is no
 * less real than a model-proposed one) and is logged to the run's
 * events.jsonl, so replays are as auditable as exploration runs.
 *
 * Failure handling: a step whose semantic AND selector attempts both fail
 * wakes the healer (if any) for just that step; a successful patch is written
 * back to the skill file. A post-condition mismatch is not healed -- the
 * engine can't know which earlier step lied -- it fails the replay.
 */

export interface ConfirmFn {
  (tool: string, args: Record<string, unknown>, matchedRule: unknown, context?: string): Promise<{ approved: boolean; note?: string }>;
}

export interface ReplayEngineOptions {
  store: SkillStore;
  mcp: McpClientManager;
  policy: PolicyEngine;
  logger: RunLogger;
  healer?: Healer;
  /** Max healed steps per replay (default 3). */
  maxHeals?: number;
  /** Injectable for tests; defaults to the interactive CLI prompt. */
  confirm?: ConfirmFn;
}

export interface ReplayOutcome {
  status: "success" | "failure" | "blocked";
  summary: string;
  stepsExecuted: number;
  healsApplied: number;
  /** LLM calls made (0 on the happy path -- the product thesis, asserted in tests). */
  llmCalls: number;
  primitivesRun: string[];
}

interface PlanEntry {
  skill: Skill;
  params: Record<string, string>;
}

const MAX_FLOW_DEPTH = 10;

/** Tools that accept semantic role+name targeting as an alternative to a CSS selector. */
const SEMANTIC_TOOLS = new Set(["browser__click", "browser__fill"]);

class ReplayBlocked extends Error {}

function textOfResult(result: McpToolResult): string {
  return result.content
    .map((b) => (b.type === "text" ? (b.text ?? "") : `[${b.type}]`))
    .join("\n");
}

/**
 * Expands a skill (flow or primitive) into an ordered list of primitives with
 * their resolved params. Flow call params are templates over the parent's
 * params (e.g. { sku: "{{sku}}" }).
 */
export function resolvePlan(store: SkillStore, name: string, params: Record<string, string>, depth = 0, trail: string[] = []): PlanEntry[] {
  if (depth > MAX_FLOW_DEPTH) throw new Error(`flow nesting exceeds ${MAX_FLOW_DEPTH} (cycle? trail: ${trail.join(" -> ")})`);
  if (trail.includes(name)) throw new Error(`flow cycle detected: ${[...trail, name].join(" -> ")}`);
  const skill = store.load(name);

  if (isFlowSkill(skill)) {
    return skill.calls.flatMap((call) => {
      const childParams = Object.fromEntries(
        Object.entries(call.params).map(([k, v]) => [k, substituteString(v, params)]),
      );
      return resolvePlan(store, call.skill, childParams, depth + 1, [...trail, name]);
    });
  }

  const missing = skill.params.filter((p) => params[p.name] === undefined).map((p) => p.name);
  if (missing.length) {
    throw new ParamError(
      `skill "${name}" is missing parameter(s): ${missing.join(", ")} (required: ${skill.params.map((p) => `${p.name} (e.g. ${p.example})`).join(", ")})`,
    );
  }
  return [{ skill, params }];
}

export async function replaySkill(name: string, params: Record<string, string>, opts: ReplayEngineOptions): Promise<ReplayOutcome> {
  const confirm: ConfirmFn = opts.confirm ?? ((tool, args, rule, ctx) => confirmToolCall(tool, args, rule as never, ctx));
  const maxHeals = opts.maxHeals ?? 3;
  const outcome: ReplayOutcome = { status: "success", summary: "", stepsExecuted: 0, healsApplied: 0, llmCalls: 0, primitivesRun: [] };

  let plan: PlanEntry[];
  try {
    plan = resolvePlan(opts.store, name, params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.logger.log({ type: "replay_error", skill: name, error: msg });
    return { ...outcome, status: "failure", summary: msg };
  }

  opts.logger.log({ type: "replay_start", skill: name, params, plan: plan.map((e) => e.skill.name) });

  // Gated + logged tool execution shared by steps, patches, and post-conditions.
  const execute = async (tool: string, args: Record<string, unknown>, context: string): Promise<{ ok: boolean; text: string }> => {
    const decision = opts.policy.evaluate(tool, args);
    opts.logger.log({ type: "policy_decision", tool, action: decision.action, matchedRule: decision.matchedRule, context });
    if (decision.action === "deny") {
      throw new ReplayBlocked(`step tool "${tool}" is denied by policy`);
    }
    if (decision.action === "ask") {
      const confirmation = await confirm(tool, args, decision.matchedRule, context);
      opts.logger.log({ type: "human_decision", tool, decision: confirmation.approved ? "approved" : "denied", note: confirmation.note });
      if (!confirmation.approved) throw new ReplayBlocked(`step tool "${tool}" was denied by the human operator`);
    }
    const start = Date.now();
    try {
      const result = await opts.mcp.callTool(tool, args);
      const text = textOfResult(result);
      opts.logger.log({ type: "replay_step", context, tool, args, isError: Boolean(result.isError), durationMs: Date.now() - start, resultText: text.slice(0, 1000) });
      return { ok: !result.isError, text };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      opts.logger.log({ type: "replay_step", context, tool, args, isError: true, durationMs: Date.now() - start, resultText: text.slice(0, 1000) });
      return { ok: false, text };
    }
  };

  try {
    for (const entry of plan) {
      const { skill } = entry;
      outcome.primitivesRun.push(skill.name);

      for (let i = 0; i < skill.steps.length; i++) {
        const step = skill.steps[i]!;
        const ctx = `${skill.name}[${i}]`;

        if (step.waitFor?.selector || step.waitFor?.ms) {
          await execute("browser__wait_for", step.waitFor.selector ? { selector: step.waitFor.selector } : { ms: step.waitFor.ms }, `${ctx} waitFor`);
        }

        const args = substituteArgs(step.args, entry.params);

        // Semantic-first: anchor on role + accessible name when the step
        // carries a locator and the tool supports it; the recorded selector
        // is the second chance, not the primary anchor.
        const attempts: Array<{ args: Record<string, unknown>; kind: string }> = [];
        if (step.locator && SEMANTIC_TOOLS.has(step.tool)) {
          const locatorName = substituteString(step.locator.name, entry.params);
          const semanticArgs: Record<string, unknown> = { role: step.locator.role, name: locatorName };
          if (step.tool === "browser__fill" && typeof args.value === "string") semanticArgs.value = args.value;
          attempts.push({ args: semanticArgs, kind: "semantic" });
        }
        attempts.push({ args, kind: "selector" });

        let ok = false;
        let lastError = "";
        for (const attempt of attempts) {
          const r = await execute(step.tool, attempt.args, `${ctx} (${attempt.kind})`);
          if (r.ok) {
            ok = true;
            break;
          }
          lastError = r.text;
        }

        if (!ok && opts.healer && outcome.healsApplied < maxHeals) {
          const patched = await heal(skill, i, step, entry.params, lastError, opts, outcome);
          if (patched) {
            const patchArgs = substituteArgs(patched.args, entry.params);
            const r = await execute(patched.tool, patchArgs, `${ctx} (healed)`);
            if (r.ok) {
              persistPatch(opts.store, skill.name, i, patched, opts.logger);
              outcome.healsApplied++;
              ok = true;
            } else {
              lastError = r.text;
            }
          }
        }

        if (!ok) {
          outcome.status = "failure";
          outcome.summary = `step ${ctx} (${step.tool}) failed: ${lastError.slice(0, 500)}`;
          opts.logger.log({ type: "replay_finish", ...outcome });
          return outcome;
        }
        outcome.stepsExecuted++;
      }

      // Post-condition: the primitive isn't "done" because its steps ran; it's
      // done because the read-back check matches.
      const post = skill.postCondition;
      const postArgs = substituteArgs(post.args, entry.params);
      const pattern = substitutePattern(post.expectPattern, entry.params);
      const r = await execute(post.tool, postArgs, `${skill.name} postCondition`);
      const matched = r.ok && new RegExp(pattern).test(r.text);
      opts.logger.log({ type: "verification", tool: post.tool, args: postArgs, expectPattern: pattern, matched, isError: !r.ok, resultText: r.text.slice(0, 2000), skill: skill.name });
      if (!matched) {
        outcome.status = "failure";
        outcome.summary = `post-condition of "${skill.name}" failed: result did not match /${pattern}/ (got: ${r.text.slice(0, 300)})`;
        opts.logger.log({ type: "replay_finish", ...outcome });
        return outcome;
      }
    }
  } catch (err) {
    if (err instanceof ReplayBlocked) {
      outcome.status = "blocked";
      outcome.summary = err.message;
    } else {
      outcome.status = "failure";
      outcome.summary = err instanceof Error ? err.message : String(err);
    }
    opts.logger.log({ type: "replay_finish", ...outcome });
    return outcome;
  }

  outcome.summary = `replayed ${outcome.primitivesRun.join(" -> ")} (${outcome.stepsExecuted} steps, ${outcome.healsApplied} heal(s), ${outcome.llmCalls} LLM call(s))`;
  opts.logger.log({ type: "replay_finish", ...outcome });
  return outcome;
}

async function heal(
  skill: Skill,
  stepIndex: number,
  step: SkillStep,
  params: Record<string, string>,
  error: string,
  opts: ReplayEngineOptions,
  outcome: ReplayOutcome,
): Promise<SkillStep | null> {
  let snapshot = "";
  if (step.tool.startsWith("browser__")) {
    try {
      const r = await opts.mcp.callTool("browser__snapshot", {});
      snapshot = textOfResult(r).slice(0, 8000);
    } catch {
      /* no browser available -- heal blind */
    }
  }
  try {
    outcome.llmCalls++;
    const patched = await opts.healer!({
      skillName: skill.name,
      skillDescription: skill.description,
      stepIndex,
      step,
      params,
      error: error.slice(0, 1000),
      snapshot,
      availableTools: opts.mcp.tools.flatMap((t) => (t.type === "function" ? [t.function.name] : [])),
    });
    opts.logger.log({ type: "heal_proposed", skill: skill.name, stepIndex, from: step, to: patched });
    return patched;
  } catch (err) {
    opts.logger.log({ type: "heal_failed", skill: skill.name, stepIndex, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Write the patch back so one heal fixes every flow that uses this skill. */
function persistPatch(store: SkillStore, skillName: string, stepIndex: number, patched: SkillStep, logger: RunLogger): void {
  const fresh = store.load(skillName);
  if (isFlowSkill(fresh)) return; // defensive; only primitives reach here
  fresh.steps[stepIndex] = patched;
  const path = store.save(fresh);
  logger.log({ type: "heal_applied", skill: skillName, stepIndex, path });
}
