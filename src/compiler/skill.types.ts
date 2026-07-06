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
}

export type AnySkill = Skill | FlowSkill;

export function isFlowSkill(s: AnySkill): s is FlowSkill {
  return s.kind === "flow";
}
