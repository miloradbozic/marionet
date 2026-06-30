import type OpenAI from "openai";

export interface FinishTaskInput {
  status: "success" | "failure" | "blocked";
  summary: string;
  details?: string;
}

export const FINISH_TASK_TOOL_NAME = "finish_task";

export const FINISH_TASK_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: FINISH_TASK_TOOL_NAME,
    description:
      "Call this when the task is complete, or when you determine it cannot be completed. This is the only way to end the run -- do not just stop responding or produce a final text-only answer.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["success", "failure", "blocked"], description: "How the task ended" },
        summary: { type: "string", description: "One or two sentences on the outcome" },
        details: { type: "string", description: "Optional additional detail" },
      },
      required: ["status", "summary"],
    },
  },
};
