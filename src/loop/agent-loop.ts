import type OpenAI from "openai";
import { estimateCostUsd, withLlmRetry } from "../llm-client.js";
import type { McpClientManager } from "../mcp/mcp-client-manager.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import { confirmToolCall } from "../confirm/cli-prompt.js";
import type { RunLogger } from "../logging/run-logger.js";
import { FINISH_TASK_TOOL, FINISH_TASK_TOOL_NAME, type FinishTaskInput } from "./finish-task-tool.js";
import { mcpResultToToolContent } from "./message-mapper.js";

const SYSTEM_PROMPT = `/no_think
You are marionet, an autonomous agent with shell, filesystem, and browser access on the operator's machine.

When the task is complete, or you determine it cannot be completed, you must call finish_task -- do not just stop responding or produce a final text-only answer. That is the only way this run ends.

Finishing with status "success" requires a verification: a read-only tool call the system executes to independently confirm the outcome (e.g. browser__eval reading an input's .value, fs__read of a written file, a read-only shell command). Choose a check that reads durable state -- never a success toast or notification, those disappear and are unreliable. If verification fails you will get the result back and the run continues: fix the problem or finish with status "failure".

Some tool calls pause for human confirmation; a denied call returns an error tool_result explaining why. If one is denied, adapt your approach rather than retrying the same call, or call finish_task with status "blocked".

Recognize "not found" as a terminal answer, not an obstacle. If a search, lookup, or query returns an explicit empty state -- "0 results", "no products", "not found", "Sorry, there is nothing for your search", an empty list -- the thing you were told to act on very likely does not exist. Do NOT retry the same query, clear filters speculatively, or guess alternate URLs to conjure it into existence. Confirm the empty state once (read the result count or the empty-state message with browser__extract), then call finish_task with status "blocked" or "failure" and say plainly what was not found (e.g. "product 20345121 does not exist in this instance -- search returned 0 products"). A correct "it doesn't exist" finish is a success of the run; endless retrying is the failure.

Browser perception — how to find elements:
- Use browser__snapshot to see the page: it lists every visible interactive element with a ref (e1, e2, ...), role, name, and state. Act on refs with browser__click_ref / browser__fill_ref (and browser__fill_from_env with ref for secrets). Do NOT guess CSS selectors; snapshot first, then act.
- Use the query argument to filter large pages (e.g. query "save" to find save buttons) and scope to limit to a region.
- Refs expire on navigation and framework re-renders. After a page-changing action, re-snapshot before acting on old refs. If a ref-based call fails, re-snapshot.
- CSS-selector tools (browser__click, browser__fill, browser__wait_for) remain available for selectors you know from a playbook or cache; prefer refs for anything discovered fresh.

Efficiency rules — these are hard constraints, not suggestions:
- If playbooks are provided in the client context below (or the task points at one), follow them exactly when they cover a step you are about to take, without any extra inspection or extraction first. Playbooks contain the real site URLs and known-working selectors.
- At the start of a browser flow, call browser__cache_read using the ACTUAL site URL from the playbook or task (never a placeholder URL). If it returns cached data, use those selectors IMMEDIATELY and DIRECTLY -- do not call browser__extract or any other tool to "verify" or "explore" first. Skip all discovery entirely. After a flow succeeds, call browser__cache_write with only the keys the next run can use directly (flat object, no prose).
- Do NOT extract page state mid-flow to confirm a click or fill succeeded. Trust tool calls unless they return an error. Bad pattern: navigate → extract → click → extract → fill → extract. Good pattern: navigate → click → fill → save → finish_task (with verification). Only extract when you need data to decide the NEXT action.
- After executing a save (JS click or browser__submit_form), call finish_task immediately with a verification that re-reads the saved state deterministically (e.g. browser__eval on the input's .value). Do not check success toasts -- they disappear in seconds and are unreliable.
- NEVER use browser__extract with format "html" and selector "body" or no selector. This is banned -- it costs 10x tokens for near-zero value. HTML extracts must always use a specific, narrow selector. Use text format for reading content.
- NEVER take a screenshot except as a last resort when completely stuck.
- After navigating to a site, take a browser__snapshot FIRST to see the actual page state -- never browser__wait_for a login field to "check" if login is needed (a 30s timeout on an already-authenticated page is pure waste). If the snapshot shows a login form, log in; if it shows the app, proceed.
- Batch independent tool calls in a single response (e.g. fill multiple fields at once, not one per turn).
- Prefer clicking navigation elements over guessing URLs -- SPAs use hash or API-driven routing that is hard to predict.`;

/** How many identical failing tool calls before the loop guard escalates. */
const REPEAT_FAILURE_LIMIT = 3;

/**
 * Tool-call arguments arrive as a JSON string the model generated, so they can
 * be malformed (unescaped quotes/newlines in a JS expression are the usual
 * culprit). A single bad tool call must never crash the whole run -- parse
 * defensively and turn a parse failure into a recoverable error for the model.
 */
function safeParseArgs(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    return { ok: true, value: (JSON.parse(raw) as Record<string, unknown>) ?? {} };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

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
  /** Rendered client context (identity + playbooks), appended to the system prompt. */
  clientPromptSection?: string;
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

function textOfResult(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`))
    .join("\n");
}

/**
 * Executes the model-proposed verification for a successful finish_task and
 * returns a rejection message if the run must NOT end, or null if it may.
 * The verification call goes through the same policy gate as any tool call,
 * so the model cannot use it to smuggle in a denied action.
 */
async function runFinishVerification(input: FinishTaskInput, opts: AgentLoopOptions): Promise<string | null> {
  const v = input.verification;
  if (!v || !v.tool || !v.expectPattern) {
    return 'finish_task rejected: status "success" requires a verification ({ tool, args, expectPattern }) -- a read-only tool call that independently confirms the outcome. Provide one, or finish with status "failure" or "blocked".';
  }

  const decision = opts.policy.evaluate(v.tool, v.args ?? {});
  opts.logger.log({ type: "policy_decision", tool: v.tool, action: decision.action, matchedRule: decision.matchedRule, context: "finish_verification" });
  if (decision.action === "deny") {
    return `finish_task rejected: verification tool "${v.tool}" is denied by policy. Choose a different read-only verification.`;
  }
  if (decision.action === "ask") {
    const confirmation = await confirmToolCall(v.tool, v.args ?? {}, decision.matchedRule, `verification for finish_task: ${input.summary}`);
    if (!confirmation.approved) {
      return `finish_task rejected: verification was denied by the human operator.${confirmation.note ? ` Reason: ${confirmation.note}` : ""}`;
    }
  }

  let resultText: string;
  let isError = false;
  try {
    const result = await opts.mcpClientManager.callTool(v.tool, v.args ?? {});
    resultText = textOfResult(result);
    isError = Boolean(result.isError);
  } catch (err) {
    resultText = err instanceof Error ? err.message : String(err);
    isError = true;
  }

  let matched = false;
  let patternError: string | null = null;
  try {
    matched = !isError && new RegExp(v.expectPattern).test(resultText);
  } catch (err) {
    patternError = err instanceof Error ? err.message : String(err);
  }

  opts.logger.log({
    type: "verification",
    tool: v.tool,
    args: v.args ?? {},
    expectPattern: v.expectPattern,
    matched,
    isError,
    resultText: resultText.slice(0, 2000),
  });

  if (patternError) {
    return `finish_task rejected: expectPattern is not a valid regex (${patternError}).`;
  }
  if (!matched) {
    return `finish_task rejected: verification failed. ${isError ? "Verification tool errored" : `Result did not match /${v.expectPattern}/`}. Tool result:\n${resultText.slice(0, 2000)}\n\nFix the problem and finish again, or finish with status "failure".`;
  }
  return null;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const systemPrompt = opts.clientPromptSection ? `${SYSTEM_PROMPT}\n${opts.clientPromptSection}` : SYSTEM_PROMPT;
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: opts.task },
  ];
  const tools: OpenAI.ChatCompletionTool[] = [...opts.mcpClientManager.tools, FINISH_TASK_TOOL];

  let totalCostUsd = 0;
  let iter = 0;
  let nudges = 0;
  const failureCounts = new Map<string, number>();

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

    const response = await withLlmRetry(
      () =>
        opts.llmClient.chat.completions.create({
          model: opts.model,
          max_tokens: opts.maxTokens,
          tools,
          messages,
        }),
      {
        onRetry: ({ attempt, error, delayMs }) => opts.logger.log({ type: "llm_retry", attempt, error, delayMs }),
      },
    );

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
      toolUses: toolCalls.map((tc) => {
        const parsed = safeParseArgs(tc.function.arguments);
        return {
          id: tc.id,
          name: tc.function.name,
          input: parsed.ok ? parsed.value : { _unparsed: tc.function.arguments, _parseError: parsed.error },
        };
      }),
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
      const parsed = safeParseArgs(tc.function.arguments);
      if (!parsed.ok) {
        opts.logger.log({
          type: "tool_result",
          toolUseId: tc.id,
          tool: name,
          isError: true,
          durationMs: 0,
          content: [{ type: "text", text: `Invalid JSON arguments: ${parsed.error}` }],
        });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Your ${name} call arguments were not valid JSON (${parsed.error}). Re-send the call with correctly escaped JSON -- if a value contains quotes, newlines, or backslashes (e.g. a JS expression for browser__eval), escape them properly, or prefer a dedicated tool like browser__click_text so you don't have to hand-write JS.`,
        });
        continue;
      }
      const args = parsed.value;

      if (name === FINISH_TASK_TOOL_NAME) {
        const input = args as unknown as FinishTaskInput;

        if (input.status === "success") {
          const rejection = await runFinishVerification(input, opts);
          if (rejection) {
            opts.logger.log({ type: "finish_rejected", reason: rejection });
            messages.push({ role: "tool", tool_call_id: tc.id, content: rejection });
            continue;
          }
        }

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
      let content: string;
      let isError: boolean;
      try {
        const result = await opts.mcpClientManager.callTool(name, args);
        isError = Boolean(result.isError);
        opts.logger.log({
          type: "tool_result",
          toolUseId: tc.id,
          tool: name,
          isError,
          durationMs: Date.now() - start,
          content: result.content,
        });
        content = mcpResultToToolContent(result, opts.supportsVision ?? true);
      } catch (err) {
        isError = true;
        content = err instanceof Error ? err.message : String(err);
        opts.logger.log({
          type: "tool_result",
          toolUseId: tc.id,
          tool: name,
          isError: true,
          durationMs: Date.now() - start,
          content: [{ type: "text", text: content }],
        });
      }

      // Loop guard: a model that keeps re-issuing the *same* failing call is
      // stuck, not making progress. After a few identical failures, escalate
      // the tool result with an explicit course-correction so it stops burning
      // turns on a doomed action (see the Akeneo search loop, run deesdu).
      if (isError && typeof content === "string") {
        // Normalize out volatile "how long to wait" knobs so a model that just
        // keeps bumping timeoutMs (or re-waiting) still counts as the same
        // failing action and trips the guard.
        const sigArgs: Record<string, unknown> = { ...args };
        delete sigArgs.timeoutMs;
        delete sigArgs.ms;
        const signature = `${name}:${JSON.stringify(sigArgs)}`;
        const count = (failureCounts.get(signature) ?? 0) + 1;
        failureCounts.set(signature, count);
        if (count >= REPEAT_FAILURE_LIMIT) {
          opts.logger.log({ type: "loop_guard", tool: name, count });
          content = `${content}\n\n[marionet] You have now called ${name} with these exact arguments ${count} times and it has failed every time. Stop repeating it. Do something different: take a browser__snapshot to find the real element, try a different tool or selector, or call finish_task with status "blocked" if you genuinely cannot proceed.`;
        }
      }

      messages.push({ role: "tool", tool_call_id: tc.id, content });
    }

    if (finishResult) return finishResult;
  }
}
