import type Anthropic from "@anthropic-ai/sdk";
import { estimateCostUsd } from "../anthropic-client.js";
import type { McpClientManager } from "../mcp/mcp-client-manager.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import { confirmToolCall } from "../confirm/cli-prompt.js";
import type { RunLogger } from "../logging/run-logger.js";
import { FINISH_TASK_TOOL, FINISH_TASK_TOOL_NAME, type FinishTaskInput } from "./finish-task-tool.js";
import { mcpResultToToolResultContent } from "./message-mapper.js";

const SYSTEM_PROMPT = `You are marionet, an autonomous agent with shell, filesystem, and browser access on the operator's machine.

When the task is complete, or you determine it cannot be completed, you must call finish_task -- do not just stop responding or produce a final text-only answer. That is the only way this run ends.

Some tool calls pause for human confirmation; a denied call returns an error tool_result explaining why. If one is denied, adapt your approach rather than retrying the same call, or call finish_task with status "blocked".

Efficiency rules:
- At the start of any browser flow, call browser__cache_read with the site URL and flow name (e.g. "login", "products_grid"). If it returns cached data, use those selectors directly -- skip all discovery. After a flow succeeds, call browser__cache_write to persist what you used.
- Batch independent tool calls in a single response whenever possible (e.g. fill multiple form fields in one turn, not one per turn).
- Prefer clicking navigation elements over guessing URLs -- SPAs use hash or API-driven routing that is hard to predict.
- Avoid taking screenshots unless you are genuinely stuck and need to see the page state.`;

/** Minimal surface the loop needs from an Anthropic client -- lets tests inject a fake. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface AgentLoopOptions {
  task: string;
  model: string;
  maxTokens: number;
  maxTurns: number;
  maxCostUsd: number;
  anthropicClient: MessagesClient;
  mcpClientManager: McpClientManager;
  policy: PolicyEngine;
  logger: RunLogger;
}

export interface AgentLoopResult {
  status: "success" | "failure" | "blocked" | "halted";
  summary: string;
  details?: string;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const anthropic = opts.anthropicClient;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.task }];
  const tools: Anthropic.Tool[] = [...opts.mcpClientManager.anthropicTools, FINISH_TASK_TOOL];

  let totalCostUsd = 0;
  let iter = 0;
  let nudges = 0;

  for (;;) {
    iter++;
    opts.logger.setIter(iter);

    if (iter > opts.maxTurns) {
      opts.logger.log({ type: "run_halted", reason: "turn_ceiling" });
      return { status: "halted", summary: `Stopped after ${opts.maxTurns} turns without finish_task.` };
    }
    if (totalCostUsd > opts.maxCostUsd) {
      opts.logger.log({ type: "run_halted", reason: "cost_ceiling", totalCostUsd });
      return { status: "halted", summary: `Stopped after exceeding the $${opts.maxCostUsd} cost ceiling.` };
    }

    const response = await anthropic.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    totalCostUsd += estimateCostUsd(opts.model, response.usage);

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const reasoningText = textBlocks.map((b) => b.text).join("\n") || undefined;

    opts.logger.log({
      type: "model_response",
      stopReason: response.stop_reason,
      text: reasoningText,
      toolUses: toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input })),
      usage: response.usage,
    });

    messages.push({ role: "assistant", content: response.content });

    if (toolUseBlocks.length === 0) {
      nudges++;
      opts.logger.log({ type: "nudge" });
      if (iter + nudges > opts.maxTurns) {
        opts.logger.log({ type: "run_halted", reason: "turn_ceiling" });
        return { status: "halted", summary: "Model stopped calling tools without calling finish_task." };
      }
      messages.push({
        role: "user",
        content: "Continue the task, or call finish_task if it's complete or cannot be completed.",
      });
      continue;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let finishResult: AgentLoopResult | null = null;

    for (const block of toolUseBlocks) {
      if (block.name === FINISH_TASK_TOOL_NAME) {
        const input = block.input as FinishTaskInput;
        opts.logger.log({ type: "finish_task", status: input.status, summary: input.summary, details: input.details });
        finishResult = { status: input.status, summary: input.summary, details: input.details };
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Task finished." });
        continue;
      }

      const args = block.input as Record<string, unknown>;
      const decision = opts.policy.evaluate(block.name, args);
      opts.logger.log({
        type: "policy_decision",
        toolUseId: block.id,
        tool: block.name,
        action: decision.action,
        matchedRule: decision.matchedRule,
      });

      if (decision.action === "deny") {
        opts.logger.log({ type: "human_decision", toolUseId: block.id, decision: "denied", note: "policy default-deny" });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Denied by policy: no matching allow rule for "${block.name}".`,
          is_error: true,
        });
        continue;
      }

      if (decision.action === "ask") {
        const confirmation = await confirmToolCall(block.name, args, decision.matchedRule, reasoningText);
        opts.logger.log({
          type: "human_decision",
          toolUseId: block.id,
          decision: confirmation.approved ? "approved" : "denied",
          note: confirmation.approved ? undefined : confirmation.note,
        });
        if (!confirmation.approved) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Denied by human operator.${confirmation.note ? ` Reason: ${confirmation.note}` : ""}`,
            is_error: true,
          });
          continue;
        }
      }

      const start = Date.now();
      try {
        const result = await opts.mcpClientManager.callTool(block.name, args);
        opts.logger.log({
          type: "tool_result",
          toolUseId: block.id,
          tool: block.name,
          isError: Boolean(result.isError),
          durationMs: Date.now() - start,
          content: result.content,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: mcpResultToToolResultContent(result),
          is_error: result.isError,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.logger.log({
          type: "tool_result",
          toolUseId: block.id,
          tool: block.name,
          isError: true,
          durationMs: Date.now() - start,
          content: [{ type: "text", text: message }],
        });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: message, is_error: true });
      }
    }

    messages.push({ role: "user", content: toolResults });

    if (finishResult) return finishResult;
  }
}
