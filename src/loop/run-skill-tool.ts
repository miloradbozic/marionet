import type OpenAI from "openai";

/**
 * Synthetic loop tool (like finish_task): lets the exploration agent execute
 * an already-compiled skill instead of rediscovering the flow click by click.
 * The skill's steps run through the replay engine -- each underlying tool call
 * is still policy-gated and logged. No healer is attached: if a skill breaks
 * mid-run, the agent recovers reactively, which it is already good at.
 */

export const RUN_SKILL_TOOL_NAME = "run_skill";

export interface SkillSummary {
  name: string;
  description: string;
  params: Array<{ name: string; example: string }>;
}

export interface SkillRunner {
  available(): SkillSummary[];
  run(name: string, params: Record<string, string>): Promise<{ status: string; summary: string }>;
}

export function buildRunSkillTool(skills: SkillSummary[]): OpenAI.ChatCompletionTool {
  const catalog = skills
    .map((s) => `- ${s.name}(${s.params.map((p) => p.name).join(", ")}): ${s.description}`)
    .join("\n");
  return {
    type: "function",
    function: {
      name: RUN_SKILL_TOOL_NAME,
      description:
        `Execute a compiled skill: a known-good, verified sequence of tool calls recorded from a previous successful run. ` +
        `STRONGLY prefer this over redoing a flow step by step when a skill covers what you need -- it is faster and already verified. ` +
        `Each skill ends with a post-condition check; the result tells you whether it passed.\n\nAvailable skills:\n${catalog}`,
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string", description: "Name of the skill to run" },
          params: {
            type: "object",
            description: "Parameter values for the skill, e.g. {\"sku\": \"901384900\"}",
            additionalProperties: { type: "string" },
          },
        },
        required: ["skill"],
      },
    },
  };
}
