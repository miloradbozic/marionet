import type { McpClientManager, McpToolResult } from "../mcp/mcp-client-manager.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import type { RunLogger } from "../logging/run-logger.js";
import { confirmToolCall } from "../confirm/cli-prompt.js";
import { healCount, isFlowSkill, REEXPLORE_HEAL_THRESHOLD, renderLineage, type LineageEntry, type SemanticLocator, type Skill, type SkillStep } from "../compiler/skill.types.js";
import { isFragile } from "../compiler/stability.js";
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
 * back to the skill file. A post-condition mismatch is retried (the read can
 * race a slow SPA render) but never healed -- the engine can't know which
 * earlier step lied -- so a persistent mismatch fails the replay.
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
  /** Delay before each post-condition re-read (default 2000ms; 0 in tests). */
  postRetryDelayMs?: number;
}

export interface ReplayOutcome {
  status: "success" | "failure" | "blocked";
  summary: string;
  stepsExecuted: number;
  healsApplied: number;
  /** LLM calls made (0 on the happy path -- the product thesis, asserted in tests). */
  llmCalls: number;
  primitivesRun: string[];
  /** Primitives whose skipIf matched: goal already achieved, steps not executed. */
  primitivesSkipped: string[];
  /**
   * Skills whose lineage has now accumulated enough heals that re-exploring
   * beats patching (P25). Advisory: surfaced to the operator, never acted on.
   */
  reExploreProposed: string[];
  /**
   * Result text of the last primitive's post-condition read. This is how
   * read-only skills return data: their post-condition IS the read, and the
   * caller (run_skill / CLI) gets the value instead of just pass/fail.
   */
  finalRead?: string;
  /**
   * The exact {tool, args, expectPattern} that produced finalRead, with
   * params already substituted. This already IS an independently-executed
   * read-only check -- callers (run_skill) surface it so the model can reuse
   * it verbatim as finish_task's verification instead of inventing a fresh
   * (and possibly wrong) one from scratch.
   */
  finalVerification?: { tool: string; args: Record<string, unknown>; expectPattern: string };
}

interface PlanEntry {
  skill: Skill;
  params: Record<string, string>;
}

const MAX_FLOW_DEPTH = 10;

/** Post-condition re-reads after an initial mismatch (read-only, so retrying is safe). */
const POST_CONDITION_RETRIES = 3;

/** Tools that accept semantic role+name targeting as an alternative to a CSS selector. */
const SEMANTIC_TOOLS = new Set(["browser__click", "browser__fill"]);

/**
 * Tools that cannot change the system of record. Fail-closed allowlist: a tool
 * is read-only only if named here, so a new verb is inert until someone
 * classifies it deliberately.
 *
 * Deliberately excluded even though they look harmless: `browser__click` and
 * `browser__reveal` (a click is a save as often as it is a tab switch, and the
 * step can't tell us which) and `browser__eval` (arbitrary JS -- it can do
 * anything a write can).
 */
const READ_ONLY_TOOLS = new Set([
  "browser__navigate",
  "browser__snapshot",
  "browser__extract",
  "browser__enumerate",
  "browser__wait_for",
  "browser__scroll",
  "browser__scroll_until_visible",
  "fs__read",
  "fs__list",
]);

export interface PrefixStep {
  skill: Skill;
  stepIndex: number;
  step: SkillStep;
  params: Record<string, string>;
}

/**
 * The leading run of read-only steps across a plan -- attach, navigate, locate
 * -- stopping at the first step that could write.
 *
 * This is what a warm-up executes: it exercises exactly the two things that
 * break between a skill's last good run and this one (the session died, the
 * page was redesigned) and nothing that could be regretted if they have.
 */
export function readOnlyPrefix(plan: PlanEntry[]): PrefixStep[] {
  const prefix: PrefixStep[] = [];
  for (const entry of plan) {
    for (const [stepIndex, step] of entry.skill.steps.entries()) {
      if (!READ_ONLY_TOOLS.has(step.tool)) return prefix;
      prefix.push({ skill: entry.skill, stepIndex, step, params: entry.params });
    }
  }
  return prefix;
}

/**
 * Semantic-first: anchor on role + accessible name when a locator is present
 * and the tool supports it; the recorded/patched args are the second chance,
 * not the primary anchor. Shared by original steps AND healed patches -- a
 * heal patch's `locator` is not guaranteed to be duplicated into its `args`
 * (the heal LLM sometimes fills one and not the other), so patches need the
 * same fallback original steps get, not a single bare attempt.
 *
 * ...unless the anchor is FRAGILE (`stability.ts`), in which case the order
 * inverts. Semantic-first is justified by role+name outliving CSS churn -- but
 * an anchor whose name carries a completeness percentage or an "updated"
 * timestamp outlives nothing: it is stale as soon as the record is touched,
 * with no redeploy involved. Leading with it means every replay pays a failed
 * attempt before falling back to the selector that was going to work anyway.
 * Scored live rather than read from the stored verdict, so skills compiled
 * before the scorer existed get the same treatment.
 */
function buildAttempts(
  tool: string,
  args: Record<string, unknown>,
  locator: SemanticLocator | undefined,
  params: Record<string, string>,
): Array<{ args: Record<string, unknown>; kind: string }> {
  const semantic: Array<{ args: Record<string, unknown>; kind: string }> = [];
  if (locator && SEMANTIC_TOOLS.has(tool)) {
    const locatorName = substituteString(locator.name, params);
    const semanticArgs: Record<string, unknown> = { role: locator.role, name: locatorName };
    if (tool === "browser__fill" && typeof args.value === "string") semanticArgs.value = args.value;
    semantic.push({ args: semanticArgs, kind: isFragile(locator) ? "semantic:fragile" : "semantic" });
  }
  const selector = [{ args, kind: "selector" }];
  return isFragile(locator) ? [...selector, ...semantic] : [...semantic, ...selector];
}

class ReplayBlocked extends Error {}

type Executor = (tool: string, args: Record<string, unknown>, context: string) => Promise<{ ok: boolean; text: string }>;

/**
 * Gated + logged tool execution, shared by steps, heal patches,
 * post-conditions, and warm-ups. Every path into a tool goes through here, so
 * a replayed action is gated and audited exactly like a model-proposed one --
 * there is no trusted path that skips the policy engine.
 */
function makeExecutor(opts: ReplayEngineOptions, confirm: ConfirmFn): Executor {
  return async (tool, args, context) => {
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
}

export interface WarmUpOutcome {
  ok: boolean;
  summary: string;
  stepsRun: number;
}

/**
 * Pre-flight for a batch: execute the skill's read-only prefix once, minutes
 * before the real thing, so drift is met before the first write rather than at
 * row 117 of 300.
 *
 * This is deliberately not a scheduled sentinel probing client systems at 3am
 * -- it is part of the imminent run, costs one page load, and catches the two
 * failures that actually happen between batches: the session expired, or the
 * page was redesigned. A failure here aborts the batch with nothing written.
 */
export async function warmUpSkill(name: string, params: Record<string, string>, opts: ReplayEngineOptions): Promise<WarmUpOutcome> {
  const confirm: ConfirmFn = opts.confirm ?? ((tool, args, rule, ctx) => confirmToolCall(tool, args, rule as never, ctx));
  const execute = makeExecutor(opts, confirm);

  let plan: PlanEntry[];
  try {
    plan = resolvePlan(opts.store, name, params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.logger.log({ type: "warmup_finish", skill: name, ok: false, error: msg });
    return { ok: false, summary: msg, stepsRun: 0 };
  }

  const prefix = readOnlyPrefix(plan);
  opts.logger.log({ type: "warmup_start", skill: name, params, prefixLength: prefix.length });
  if (!prefix.length) {
    const summary = "skill has no read-only prefix to warm up (its first step already writes)";
    opts.logger.log({ type: "warmup_finish", skill: name, ok: true, stepsRun: 0, note: summary });
    return { ok: true, summary, stepsRun: 0 };
  }

  let stepsRun = 0;
  try {
    for (const { skill, stepIndex, step, params: stepParams } of prefix) {
      const ctx = `warmup ${skill.name}[${stepIndex}]`;
      const args = substituteArgs(step.args, stepParams);
      const attempts = buildAttempts(step.tool, args, step.locator, stepParams);

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
      if (!ok) {
        const summary = `warm-up failed at ${ctx} (${step.tool}): ${lastError.slice(0, 300)}`;
        opts.logger.log({ type: "warmup_finish", skill: name, ok: false, stepsRun, error: summary });
        return { ok: false, summary, stepsRun };
      }
      stepsRun++;
    }
  } catch (err) {
    const summary = err instanceof Error ? err.message : String(err);
    opts.logger.log({ type: "warmup_finish", skill: name, ok: false, stepsRun, error: summary });
    return { ok: false, summary, stepsRun };
  }

  const summary = `warm-up ok (${stepsRun} read-only step(s): session alive, page still matches the skill)`;
  opts.logger.log({ type: "warmup_finish", skill: name, ok: true, stepsRun });
  return { ok: true, summary, stepsRun };
}

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
  const outcome: ReplayOutcome = { status: "success", summary: "", stepsExecuted: 0, healsApplied: 0, llmCalls: 0, primitivesRun: [], primitivesSkipped: [], reExploreProposed: [] };

  let plan: PlanEntry[];
  try {
    plan = resolvePlan(opts.store, name, params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.logger.log({ type: "replay_error", skill: name, error: msg });
    return { ...outcome, status: "failure", summary: msg };
  }

  opts.logger.log({ type: "replay_start", skill: name, params, plan: plan.map((e) => e.skill.name) });

  const execute = makeExecutor(opts, confirm);

  // Look before you act: a skipIf probe that matches means the world is
  // already in the state that primitive leaves behind. Returns the read text
  // and the exact check that produced it (it doubles as evidence / finalRead
  // and a reusable finalVerification) on match, null otherwise.
  const checkSkipIf = async (entry: PlanEntry): Promise<{ text: string; args: Record<string, unknown>; pattern: string } | null> => {
    const probe = entry.skill.skipIf;
    if (!probe) return null;
    const args = substituteArgs(probe.args, entry.params);
    const pattern = substitutePattern(probe.expectPattern, entry.params);
    const r = await execute(probe.tool, args, `${entry.skill.name} skipIf`);
    return r.ok && new RegExp(pattern).test(r.text) ? { text: r.text, args, pattern } : null;
  };

  try {
    // Backward scan: find the LAST primitive whose goal already holds and
    // resume after it — e.g. the right product page is already open, so the
    // navigate + search primitives that would re-establish it are moot.
    let startIdx = 0;
    for (let j = plan.length - 1; j >= 0; j--) {
      const skip = await checkSkipIf(plan[j]!);
      if (skip !== null) {
        startIdx = j + 1;
        for (let k = 0; k <= j; k++) outcome.primitivesSkipped.push(plan[k]!.skill.name);
        outcome.finalRead = skip.text;
        outcome.finalVerification = { tool: plan[j]!.skill.skipIf!.tool, args: skip.args, expectPattern: skip.pattern };
        opts.logger.log({ type: "replay_skip", upTo: plan[j]!.skill.name, skipped: outcome.primitivesSkipped, resultText: skip.text.slice(0, 500) });
        break;
      }
    }

    for (let i = startIdx; i < plan.length; i++) {
      const entry = plan[i]!;
      const { skill } = entry;

      // Same look-before-you-act check mid-flow: an earlier primitive may
      // have already produced this one's goal state.
      if (i > startIdx) {
        const skip = await checkSkipIf(entry);
        if (skip !== null) {
          outcome.primitivesSkipped.push(skill.name);
          outcome.finalRead = skip.text;
          outcome.finalVerification = { tool: skill.skipIf!.tool, args: skip.args, expectPattern: skip.pattern };
          opts.logger.log({ type: "replay_skip", upTo: skill.name, skipped: [skill.name], resultText: skip.text.slice(0, 500) });
          continue;
        }
      }
      outcome.primitivesRun.push(skill.name);

      for (let i = 0; i < skill.steps.length; i++) {
        const step = skill.steps[i]!;
        const ctx = `${skill.name}[${i}]`;

        if (step.waitFor?.selector || step.waitFor?.ms) {
          await execute("browser__wait_for", step.waitFor.selector ? { selector: step.waitFor.selector } : { ms: step.waitFor.ms }, `${ctx} waitFor`);
        }

        const args = substituteArgs(step.args, entry.params);
        const attempts = buildAttempts(step.tool, args, step.locator, entry.params);

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
            const patchAttempts = buildAttempts(patched.tool, patchArgs, patched.locator, entry.params);
            let healed = false;
            for (const attempt of patchAttempts) {
              const r = await execute(patched.tool, attempt.args, `${ctx} (healed:${attempt.kind})`);
              if (r.ok) {
                healed = true;
                break;
              }
              lastError = r.text;
            }
            if (healed) {
              persistPatch(opts.store, skill.name, i, patched, opts.logger, outcome);
              outcome.healsApplied++;
              ok = true;
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
      // done because the read-back check matches. Replay moves at machine
      // speed, so the first read can race an SPA render (a "Loading..."
      // screen is DOM-quiet, so auto-settle resolves before the real content
      // arrives) -- on mismatch, re-read with a delay before failing.
      const post = skill.postCondition;
      const postArgs = substituteArgs(post.args, entry.params);
      const pattern = substitutePattern(post.expectPattern, entry.params);
      const retryDelayMs = opts.postRetryDelayMs ?? 2000;
      let r = { ok: false, text: "" };
      let matched = false;
      for (let attempt = 0; attempt <= POST_CONDITION_RETRIES; attempt++) {
        if (attempt > 0 && retryDelayMs > 0) await new Promise((res) => setTimeout(res, retryDelayMs));
        r = await execute(post.tool, postArgs, `${skill.name} postCondition`);
        matched = r.ok && new RegExp(pattern).test(r.text);
        if (matched) break;
      }
      opts.logger.log({ type: "verification", tool: post.tool, args: postArgs, expectPattern: pattern, matched, isError: !r.ok, resultText: r.text.slice(0, 2000), skill: skill.name });
      if (!matched) {
        outcome.status = "failure";
        outcome.summary = `post-condition of "${skill.name}" failed: result did not match /${pattern}/ (got: ${r.text.slice(0, 300)})`;
        opts.logger.log({ type: "replay_finish", ...outcome });
        return outcome;
      }
      outcome.finalRead = r.text;
      outcome.finalVerification = { tool: post.tool, args: postArgs, expectPattern: pattern };
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

  const ran = outcome.primitivesRun.length ? `replayed ${outcome.primitivesRun.join(" -> ")}` : "nothing to do";
  const skipped = outcome.primitivesSkipped.length ? `, skipped ${outcome.primitivesSkipped.join(" + ")} (already satisfied)` : "";
  const reExplore = outcome.reExploreProposed.length
    ? `\n     re-explore proposed: ${outcome.reExploreProposed.join(", ")} -- ${REEXPLORE_HEAL_THRESHOLD}+ heals in its lineage; the site has drifted enough that re-learning beats patching.`
    : "";
  outcome.summary =
    `${ran} (${outcome.stepsExecuted} steps, ${outcome.healsApplied} heal(s), ${outcome.llmCalls} LLM call(s)${skipped})` +
    (outcome.finalRead !== undefined ? ` -- post-condition read: ${outcome.finalRead.slice(0, 300)}` : "") +
    reExplore;
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

/**
 * What a step now aims at, for the lineage note -- the whole point of the
 * entry is telling a human what changed, and "step 1 healed (browser__click)"
 * doesn't. Reads role+name from either `locator` or `args`: the heal LLM fills
 * one or the other, not reliably both (the same asymmetry buildAttempts
 * compensates for), so a note that only reads `locator` goes blank exactly
 * when the patch was a semantic re-grounding -- the interesting case.
 */
function describeTarget(step: SkillStep): string {
  const role = step.locator?.role ?? (typeof step.args.role === "string" ? step.args.role : undefined);
  const name = step.locator?.name ?? (typeof step.args.name === "string" ? step.args.name : undefined);
  if (role && name) return ` -> ${role} "${name}"`;
  const selector = typeof step.args.selector === "string" ? step.args.selector : undefined;
  return selector ? ` -> ${selector}` : "";
}

/**
 * Write the patch back so one heal fixes every flow that uses this skill, and
 * append the heal to the skill's lineage: the file now differs from what the
 * exploration run compiled, and the next person to debug it needs to know
 * which hand changed what.
 *
 * A skill that has needed REEXPLORE_HEAL_THRESHOLD heals is no longer drifting
 * -- the site has moved out from under it, and patching step-by-step now costs
 * more than re-learning the flow. That verdict is logged and surfaced in the
 * replay summary rather than acted on: re-exploration spends a strong model
 * and wants a human who chose it.
 */
function persistPatch(
  store: SkillStore,
  skillName: string,
  stepIndex: number,
  patched: SkillStep,
  logger: RunLogger,
  outcome: ReplayOutcome,
): void {
  const fresh = store.load(skillName);
  if (isFlowSkill(fresh)) return; // defensive; only primitives reach here
  fresh.steps[stepIndex] = patched;

  const entry: LineageEntry = {
    type: "heal",
    at: new Date().toISOString(),
    note: `step ${stepIndex} healed (${patched.tool}${describeTarget(patched)}, auto-verified) in run ${logger.runId}`,
    runId: logger.runId,
    stepIndex,
  };
  fresh.lineage = [...(fresh.lineage ?? []), entry];

  const path = store.save(fresh);
  logger.log({ type: "heal_applied", skill: skillName, stepIndex, path, lineage: renderLineage(fresh.lineage) });

  const heals = healCount(fresh.lineage);
  if (heals >= REEXPLORE_HEAL_THRESHOLD && !outcome.reExploreProposed.includes(skillName)) {
    outcome.reExploreProposed.push(skillName);
    logger.log({
      type: "reexplore_proposed",
      skill: skillName,
      heals,
      threshold: REEXPLORE_HEAL_THRESHOLD,
      lineage: renderLineage(fresh.lineage),
    });
  }
}
