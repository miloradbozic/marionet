import type Anthropic from "@anthropic-ai/sdk";

export interface FinishTaskInput {
  status: "success" | "failure" | "blocked";
  summary: string;
  details?: string;
}

export const FINISH_TASK_TOOL_NAME = "finish_task";

/**
 * Loop-control tool, never routed through MCP -- it terminates the run
 * rather than calling out to any external capability.
 */
export const FINISH_TASK_TOOL: Anthropic.Tool = {
  name: FINISH_TASK_TOOL_NAME,
  description:
    "Call this when the task is complete, or when you determine it cannot be completed. This is the only way to end the run -- do not just stop responding or produce a final text-only answer.",
  input_schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["success", "failure", "blocked"], description: "How the task ended" },
      summary: { type: "string", description: "One or two sentences on the outcome" },
      details: { type: "string", description: "Optional additional detail" },
    },
    required: ["status", "summary"],
  },
};
