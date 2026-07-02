/**
 * A skill is a compiled, parameterized trajectory: the executed steps of a
 * successful+verified run, with the run-specific literals (SKUs, IDs, values)
 * replaced by named parameters, plus the verification lifted into a
 * post-condition. Phase 5's replay engine executes these directly against the
 * tools with zero LLM calls on the happy path.
 */
export interface SkillStep {
  /** MCP tool name, e.g. "browser__fill". */
  tool: string;
  /** Tool arguments; string values may contain {{param}} placeholders. */
  args: Record<string, unknown>;
}

export interface SkillPostCondition {
  tool: string;
  args: Record<string, unknown>;
  /** Regex the read-only tool result must match for the skill to be "done". */
  expectPattern: string;
}

export interface SkillParam {
  name: string;
  /** The literal value observed in the source run (used as a replay default/example). */
  example: string;
}

export interface Skill {
  name: string;
  client?: string;
  description: string;
  params: SkillParam[];
  steps: SkillStep[];
  postCondition: SkillPostCondition;
  source: {
    runId: string;
    task: string;
    model: string;
    compiledAt: string;
  };
}
