import type OpenAI from "openai";

/**
 * A read-only tool call the loop executes itself after finish_task, so that
 * "success" is grounded in observed state rather than the model's own claim.
 * The run only ends successfully if the tool result matches expectPattern.
 */
export interface FinishVerification {
  tool: string;
  args: Record<string, unknown>;
  expectPattern: string;
}

export interface FinishTaskInput {
  status: "success" | "failure" | "blocked";
  summary: string;
  details?: string;
  verification?: FinishVerification;
  /**
   * Use the verification from the most recent successful run_skill call
   * instead of specifying one. That verification is already an
   * independently-executed read-only check (the skill's own post-condition),
   * so re-running it is redundant, and hand-transcribing its {tool, args,
   * expectPattern} into a fresh tool call risks mis-escaping a JS expression
   * full of nested quotes. This flag sidesteps both.
   */
  reuseLastRunSkillVerification?: boolean;
}

export const FINISH_TASK_TOOL_NAME = "finish_task";

export const FINISH_TASK_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: FINISH_TASK_TOOL_NAME,
    description:
      'Call this when the task is complete, or when you determine it cannot be completed. This is the only way to end the run -- do not just stop responding or produce a final text-only answer. Ending with status "success" REQUIRES a verification: a read-only tool call (e.g. browser__eval reading an input value, fs__read, a read-only shell command) that the system will execute to independently confirm the outcome. If the verification does not match, the run does not end and you must fix the problem or finish with status "failure".',
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["success", "failure", "blocked"], description: "How the task ended" },
        summary: { type: "string", description: "One or two sentences on the outcome" },
        details: { type: "string", description: "Optional additional detail" },
        verification: {
          type: "object",
          description:
            'A read-only tool call that proves the outcome, executed by the system after you call finish_task. Required when status is "success", UNLESS reuseLastRunSkillVerification is true.',
          properties: {
            tool: {
              type: "string",
              description: "Name of a read-only tool to execute, e.g. browser__eval, fs__read, shell__exec",
            },
            args: {
              type: "object",
              description: "Arguments for that tool, exactly as you would call it",
            },
            expectPattern: {
              type: "string",
              description:
                "Regex tested against the text of the tool result. The run ends successfully only if it matches.",
            },
          },
          required: ["tool", "args", "expectPattern"],
        },
        reuseLastRunSkillVerification: {
          type: "boolean",
          description:
            'Set true instead of providing verification when the most recent run_skill call already succeeded: reuses its own post-condition check rather than you re-specifying (and risking mis-escaping) one.',
        },
      },
      required: ["status", "summary"],
    },
  },
};
