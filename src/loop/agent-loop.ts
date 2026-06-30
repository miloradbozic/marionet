import type OpenAI from "openai";
import { estimateCostUsd } from "../llm-client.js";
import type { McpClientManager } from "../mcp/mcp-client-manager.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import { confirmToolCall } from "../confirm/cli-prompt.js";
import type { RunLogger } from "../logging/run-logger.js";
import { FINISH_TASK_TOOL, FINISH_TASK_TOOL_NAME, type FinishTaskInput } from "./finish-task-tool.js";
import { mcpResultToToolContent } from "./message-mapper.js";

const SYSTEM_PROMPT = `/no_think
You are marionet, an autonomous agent with shell, filesystem, and browser access on the operator's machine.

When the task is complete, or you determine it cannot be completed, you must call finish_task -- do not just stop responding or produce a final text-only answer. That is the only way this run ends.

Some tool calls pause for human confirmation; a denied call returns an error tool_result explaining why. If one is denied, adapt your approach rather than retrying the same call, or call finish_task with status "blocked".

Efficiency rules — these are hard constraints, not suggestions:
- At the start of any browser task, read the site playbook first: Akeneo (any akeneo URL) → fs__read sites/akeneo.md. The playbook contains the real site URL and cached selectors. When the playbook covers a step you are about to take, follow it exactly without any extra inspection or extraction first.
- After reading the playbook, call browser__cache_read using the ACTUAL site URL from the playbook or task (e.g. https://test-opari.cloud.akeneo.com -- never use example.com or placeholder URLs). If it returns cached data, use those selectors IMMEDIATELY and DIRECTLY -- do not call browser__extract or any other tool to "verify" or "explore" first. Skip all discovery entirely. After a flow succeeds, call browser__cache_write with only the keys the next run can use directly (flat object, no prose).
- Do NOT extract page state to confirm a click or fill succeeded. Trust tool calls unless they return an error. Bad pattern: navigate → extract → click → extract → fill → extract. Good pattern: navigate → click → fill → save → finish_task. Only extract when you need data to decide the NEXT action.
- After executing a save (JS click or browser__submit_form), call finish_task immediately. Do not try to verify the save via extraction -- the success toast disappears in seconds and is unreliable. If the save JS ran without throwing an error, the save succeeded.
- NEVER use browser__extract with format "html" and selector "body" or no selector. This is banned -- it costs 10x tokens for near-zero value. HTML extracts must always use a specific, narrow selector. Use text format for reading content.
- NEVER take a screenshot except as a last resort when completely stuck.
- Before filling any login form, check if the page is already authenticated (dashboard visible, no login form). If already logged in, skip login entirely.
- Batch independent tool calls in a single response (e.g. fill multiple fields at once, not one per turn).
- Prefer clicking navigation elements over guessing URLs -- SPAs use hash or API-driven routing that is hard to predict.`;

/** Minimal surface the loop needs -- lets tests inject a fake. */
export interface LlmMessagesClient {
  chat: {
    completions: {
      create(params: OpenAI.ChatCompletionCreateParamsNonStreaming): Promise<OpenAI.ChatCompletion>;
    };
  };
}

export interface AgentLoopOptions {
  task: string;
  model: string;
  maxTokens: number;
  maxTurns: number;
  maxCostUsd: number;
  pricing?: { input: number; output: number };
  supportsVision?: boolean;
  llmClient: LlmMessagesClient;
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
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: opts.task },
  ];
  const tools: OpenAI.ChatCompletionTool[] = [...opts.mcpClientManager.tools, FINISH_TASK_TOOL];

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

    const response = await opts.llmClient.chat.completions.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      tools,
      messages,
    });

    const choice = response.choices[0]!;
    const text = choice.message.content ?? undefined;
    const toolCalls = (choice.message.tool_calls ?? []).filter(
      (tc): tc is OpenAI.ChatCompletionMessageToolCall & { type: "function" } => tc.type === "function",
    );
    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;

    totalCostUsd += estimateCostUsd(inputTokens, outputTokens, opts.pricing);

    opts.logger.log({
      type: "model_response",
      stopReason: choice.finish_reason,
      text: text || undefined,
      toolUses: toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      })),
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });

    messages.push({
      role: "assistant",
      content: text ?? null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    if (toolCalls.length === 0) {
      nudges++;
      opts.logger.log({ type: "nudge" });
      if (iter + nudges > opts.maxTurns) {
        opts.logger.log({ type: "run_halted", reason: "turn_ceiling" });
        return { status: "halted", summary: "Model stopped calling tools without calling finish_task." };
      }
      messages.push({ role: "user", content: "Continue the task, or call finish_task if it's complete or cannot be completed." });
      continue;
    }

    let finishResult: AgentLoopResult | null = null;

    for (const tc of toolCalls) {
      const name = tc.function.name;
      const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;

      if (name === FINISH_TASK_TOOL_NAME) {
        const input = args as unknown as FinishTaskInput;
        opts.logger.log({ type: "finish_task", status: input.status, summary: input.summary, details: input.details });
        finishResult = { status: input.status, summary: input.summary, details: input.details };
        messages.push({ role: "tool", tool_call_id: tc.id, content: "Task finished." });
        continue;
      }

      const decision = opts.policy.evaluate(name, args);
      opts.logger.log({
        type: "policy_decision",
        toolUseId: tc.id,
        tool: name,
        action: decision.action,
        matchedRule: decision.matchedRule,
      });

      if (decision.action === "deny") {
        opts.logger.log({ type: "human_decision", toolUseId: tc.id, decision: "denied", note: "policy default-deny" });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Denied by policy: no matching allow rule for "${name}".`,
        });
        continue;
      }

      if (decision.action === "ask") {
        const confirmation = await confirmToolCall(name, args, decision.matchedRule, text);
        opts.logger.log({
          type: "human_decision",
          toolUseId: tc.id,
          decision: confirmation.approved ? "approved" : "denied",
          note: confirmation.approved ? undefined : confirmation.note,
        });
        if (!confirmation.approved) {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `Denied by human operator.${confirmation.note ? ` Reason: ${confirmation.note}` : ""}`,
          });
          continue;
        }
      }

      const start = Date.now();
      try {
        const result = await opts.mcpClientManager.callTool(name, args);
        opts.logger.log({
          type: "tool_result",
          toolUseId: tc.id,
          tool: name,
          isError: Boolean(result.isError),
          durationMs: Date.now() - start,
          content: result.content,
        });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: mcpResultToToolContent(result, opts.supportsVision ?? true),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.logger.log({
          type: "tool_result",
          toolUseId: tc.id,
          tool: name,
          isError: true,
          durationMs: Date.now() - start,
          content: [{ type: "text", text: message }],
        });
        messages.push({ role: "tool", tool_call_id: tc.id, content: message });
      }
    }

    if (finishResult) return finishResult;
  }
}
