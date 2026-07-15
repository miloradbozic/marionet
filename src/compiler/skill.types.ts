/**
 * A skill is a compiled, parameterized trajectory: the executed steps of a
 * successful+verified run, with the run-specific literals (SKUs, IDs, values)
 * replaced by named parameters, plus a verification lifted into a
 * post-condition. Phase 5's replay engine executes these directly against the
 * tools with zero LLM calls on the happy path.
 *
 * Two kinds:
 *  - **primitive** — a flat step sequence with one post-condition. The unit of
 *    reuse and of self-heal.
 *  - **flow** — a composition of primitive skills by name. A compiled run
 *    usually yields several primitives (e.g. `open_product_by_sku`,
 *    `set_ean`) plus one flow that chains them, so the primitives can be
 *    recombined for tasks the original run never performed.
 */

/**
 * Semantic anchor for an element-targeting step: ARIA role + accessible name,
 * as reported by the browser tools' ` [target: role "name"]` result suffix.
 * Replay prefers this over the recorded CSS selector because role+name
 * survive redeploys that churn CSS class names.
 */
export interface SemanticLocator {
  role: string;
  name: string;
  /**
   * Compile-time durability verdict (`stability.ts`). Absent means the anchor
   * scored "stable" -- so a good anchor stays exactly as terse as it was, and
   * only the ones worth worrying about carry the note explaining why.
   */
  stability?: {
    score: "weak" | "fragile";
    reasons: string[];
  };
}

export interface SkillStep {
  /** MCP tool name, e.g. "browser__fill". */
  tool: string;
  /** Tool arguments; string values may contain {{param}} placeholders. */
  args: Record<string, unknown>;
  /** Semantic identity of the acted element, when the source run captured it. */
  locator?: SemanticLocator;
  /** Optional replay hint: wait for a selector / fixed delay before the step. */
  waitFor?: { selector?: string; ms?: number };
}

export interface SkillPostCondition {
  tool: string;
  args: Record<string, unknown>;
  /**
   * Regex the read-only tool result must match for the skill to be "done".
   * May contain {{param}} placeholders; replay substitutes the runtime value
   * regex-escaped.
   */
  expectPattern: string;
}

export interface SkillParam {
  name: string;
  /** The literal value observed in the source run (used as a replay default/example). */
  example: string;
}

export interface SkillSource {
  runId: string;
  task: string;
  model: string;
  compiledAt: string;
}

/**
 * One event in a skill's history: how it came to be the way it is. A skill
 * that has been healed twice and hand-patched once is not the same artifact
 * the exploration run produced, and "which of these hands broke it?" is
 * un-answerable from the JSON alone -- the state is recorded, the *becoming*
 * is not. Every write to a skill file appends an entry here.
 *
 * Types carry different trust weight: `explored` came from a verified run,
 * `heal` from an LLM patch that passed its post-condition, `human` from a
 * person editing directly.
 */
export interface LineageEntry {
  type: "explored" | "heal" | "human";
  /** ISO timestamp. */
  at: string;
  /** One human-readable line, rendered as-is by `marionet skills`. */
  note: string;
  /** The run that produced this entry (the exploration run, or the replay that healed). */
  runId?: string;
  /** Which step a heal/human patch replaced. */
  stepIndex?: number;
}

/**
 * Heals in a skill's lineage before patching stops being the cheap answer.
 * At this depth the site has drifted enough that re-learning it beats
 * accumulating scar tissue (P25: drift is data).
 */
export const REEXPLORE_HEAL_THRESHOLD = 3;

/** Heals recorded in this skill's lineage, the argument for re-exploring. */
export function healCount(lineage: LineageEntry[] | undefined): number {
  return (lineage ?? []).filter((e) => e.type === "heal").length;
}

/** Renders a lineage as the one-line chain `marionet skills` and replay banners show. */
export function renderLineage(lineage: LineageEntry[] | undefined): string {
  if (!lineage?.length) return "(no lineage recorded)";
  return lineage.map((e) => e.note).join(" -> ");
}

export interface Skill {
  /** Absent means "primitive" (backward compat with pre-segmentation files). */
  kind?: "primitive";
  name: string;
  client?: string;
  description: string;
  params: SkillParam[];
  steps: SkillStep[];
  /**
   * Optional look-before-you-act check: a read-only probe that matches when
   * the world is already in the state this primitive leaves behind, so replay
   * can skip its steps ("the right product page is already open").
   *
   * Contract: the check must be self-sufficient — it must verify everything
   * earlier primitives in a flow were needed for, not just this primitive's
   * local effect, because the replay engine uses a matching skipIf to skip
   * *predecessors* too (backward scan at replay start). A check that only
   * holds "given the right page is open" must encode which page that is
   * (e.g. via a {{param}}), or be omitted.
   */
  skipIf?: SkillPostCondition;
  postCondition: SkillPostCondition;
  source: SkillSource;
  /** How this skill came to be: compiled, then every heal/human patch since. */
  lineage?: LineageEntry[];
}

/** One composed call inside a flow; param values may contain {{param}} placeholders. */
export interface FlowCall {
  skill: string;
  params: Record<string, string>;
}

export interface FlowSkill {
  kind: "flow";
  name: string;
  client?: string;
  description: string;
  params: SkillParam[];
  calls: FlowCall[];
  source: SkillSource;
  /** How this skill came to be: compiled, then every heal/human patch since. */
  lineage?: LineageEntry[];
}

export type AnySkill = Skill | FlowSkill;

export function isFlowSkill(s: AnySkill): s is FlowSkill {
  return s.kind === "flow";
}
