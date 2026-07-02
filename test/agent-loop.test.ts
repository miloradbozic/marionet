import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { runAgentLoop, type LlmMessagesClient } from "../src/loop/agent-loop.js";
import type { McpClientManager, McpToolResult } from "../src/mcp/mcp-client-manager.js";
import type { PolicyEngine } from "../src/policy/policy-engine.js";
import type { RunLogger } from "../src/logging/run-logger.js";
import type { PolicyDecision } from "../src/policy/policy.types.js";

function makeCompletion(
  text: string | null,
  toolCalls: OpenAI.ChatCompletionMessageToolCall[],
): OpenAI.ChatCompletion {
  return {
    id: "chatcmpl_test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          refusal: null,
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

function toolCall(id: string, name: string, input: unknown): OpenAI.ChatCompletionMessageToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(input) } };
}

/** A tool call whose arguments are a raw (possibly malformed) JSON string. */
function rawToolCall(id: string, name: string, rawArgs: string): OpenAI.ChatCompletionMessageToolCall {
  return { id, type: "function", function: { name, arguments: rawArgs } };
}

const PASSING_VERIFICATION = { tool: "fs__read", args: { path: "out.txt" }, expectPattern: "ok" };

function finishTaskCompletion(
  status: "success" | "failure" | "blocked",
  summary: string,
  verification?: { tool: string; args: Record<string, unknown>; expectPattern: string },
): OpenAI.ChatCompletion {
  return makeCompletion(null, [toolCall("tc_finish", "finish_task", { status, summary, ...(verification ? { verification } : {}) })]);
}

function fakeLogger(): RunLogger {
  return { setIter: vi.fn(), log: vi.fn(), finalize: vi.fn() } as unknown as RunLogger;
}

function fakePolicy(action: PolicyDecision["action"] = "allow"): PolicyEngine {
  return {
    evaluate: vi.fn().mockReturnValue({ action, matchedRule: { match: "*", action } }),
  } as unknown as PolicyEngine;
}

function fakeMcpManager(callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>): McpClientManager {
  return { tools: [], callTool } as unknown as McpClientManager;
}

function baseOptions(overrides: Partial<Parameters<typeof runAgentLoop>[0]> = {}) {
  return {
    task: "do the thing",
    model: "test-model",
    maxTokens: 4096,
    maxTurns: 10,
    maxCostUsd: 10,
    pricing: { input: 3.0, output: 15.0 },
    llmClient: { chat: { completions: { create: vi.fn() } } } as unknown as LlmMessagesClient,
    mcpClientManager: fakeMcpManager(async () => ({ content: [{ type: "text", text: "ok" }] })),
    policy: fakePolicy("allow"),
    logger: fakeLogger(),
    ...overrides,
  };
}

describe("runAgentLoop", () => {
  it("ends the run when finish_task carries a passing verification", async () => {
    const create = vi.fn().mockResolvedValue(finishTaskCompletion("success", "All done.", PASSING_VERIFICATION));
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const result = await runAgentLoop(
      baseOptions({
        llmClient: { chat: { completions: { create } } } as unknown as LlmMessagesClient,
        mcpClientManager: fakeMcpManager(callTool),
      }),
    );
    expect(result).toEqual({ status: "success", summary: "All done.", details: undefined });
    expect(create).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("fs__read", { path: "out.txt" });
  });

  it("routes an allowed tool call through the MCP manager, then finishes on the next turn", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(makeCompletion(null, [toolCall("tc_1", "shell__exec", { command: "ls" })]))
      .mockResolvedValueOnce(finishTaskCompletion("success", "Listed files.", PASSING_VERIFICATION));
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "file1\nfile2\nok" }] });

    const result = await runAgentLoop(
      baseOptions({
        llmClient: { chat: { completions: { create } } } as unknown as LlmMessagesClient,
        mcpClientManager: fakeMcpManager(callTool),
      }),
    );

    expect(callTool).toHaveBeenCalledWith("shell__exec", { command: "ls" });
    expect(result.status).toBe("success");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("rejects a success finish that has no verification, and the run continues", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(finishTaskCompletion("success", "Done, trust me."))
      .mockResolvedValueOnce(finishTaskCompletion("success", "Done, verified.", PASSING_VERIFICATION));
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const result = await runAgentLoop(
      baseOptions({
        llmClient: { chat: { completions: { create } } } as unknown as LlmMessagesClient,
        mcpClientManager: fakeMcpManager(callTool),
      }),
    );

    expect(result.status).toBe("success");
    expect(create).toHaveBeenCalledTimes(2);

    // messages at second call: [system, user, assistant(finish_task), tool(rejection)]
    const secondCallArgs = create.mock.calls[1]![0] as OpenAI.ChatCompletionCreateParamsNonStreaming;
    const rejection = secondCallArgs.messages[3]!;
    expect(String(rejection.content)).toMatch(/requires a verification/);
  });

  it("rejects a success finish whose verification does not match, and accepts failure afterwards", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        finishTaskCompletion("success", "Saved.", { tool: "browser__eval", args: { expression: "x" }, expectPattern: "expected-value" }),
      )
      .mockResolvedValueOnce(finishTaskCompletion("failure", "Save did not stick."));
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "something-else" }] });

    const result = await runAgentLoop(
      baseOptions({
        llmClient: { chat: { completions: { create } } } as unknown as LlmMessagesClient,
        mcpClientManager: fakeMcpManager(callTool),
      }),
    );

    expect(result.status).toBe("failure");
    // messages at second call: [system, user, assistant(finish_task), tool(rejection)]
    const secondCallArgs = create.mock.calls[1]![0] as OpenAI.ChatCompletionCreateParamsNonStreaming;
    const rejection = secondCallArgs.messages[3]!;
    expect(String(rejection.content)).toMatch(/verification failed/);
  });

  it("does not execute a verification tool the policy denies", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(finishTaskCompletion("success", "Done.", PASSING_VERIFICATION))
      .mockResolvedValueOnce(finishTaskCompletion("blocked", "Cannot verify."));
    const callTool = vi.fn();

    const result = await runAgentLoop(
      baseOptions({
        llmClient: { chat: { completions: { create } } } as unknown as LlmMessagesClient,
        mcpClientManager: fakeMcpManager(callTool),
        policy: fakePolicy("deny"),
      }),
    );

    expect(callTool).not.toHaveBeenCalled();
    expect(result.status).toBe("blocked");
  });

  it("never executes a tool the policy denies, and surfaces the denial as an error tool result", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(makeCompletion(null, [toolCall("tc_1", "payments__charge_card", { amount: 100 })]))
      .mockResolvedValueOnce(finishTaskCompletion("blocked", "Could not charge card -- denied."));
    const callTool = vi.fn();

    const result = await runAgentLoop(
      baseOptions({
        llmClient: { chat: { completions: { create } } } as unknown as LlmMessagesClient,
        mcpClientManager: fakeMcpManager(callTool),
        policy: fakePolicy("deny"),
      }),
    );

    expect(callTool).not.toHaveBeenCalled();
    expect(result.status).toBe("blocked");

    // messages at second call: [system, user, assistant(tool_call), tool(denied_result)]
    const secondCallArgs = create.mock.calls[1]![0] as OpenAI.ChatCompletionCreateParamsNonStreaming;
    const toolResultMessage = secondCallArgs.messages[3]!;
    expect(String(toolResultMessage.content)).toMatch(/Denied by policy/);
  });

  it("halts once the turn ceiling is exceeded, without calling finish_task", async () => {
    const create = vi.fn().mockResolvedValue(makeCompletion(null, [toolCall("tc_1", "shell__exec", { command: "ls" })]));

    const result = await runAgentLoop(
      baseOptions({
        llmClient: { chat: { completions: { create } } } as unknown as LlmMessagesClient,
        maxTurns: 1,
      }),
    );

    expect(result.status).toBe("halted");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("halts once the cost ceiling is exceeded", async () => {
    const create = vi.fn().mockResolvedValue(makeCompletion(null, [toolCall("tc_1", "shell__exec", { command: "ls" })]));

    // 100 input * $3/M + 50 output * $15/M = $0.00105 per call, ceiling $0.001
    const result = await runAgentLoop(
      baseOptions({
        llmClient: { chat: { completions: { create } } } as unknown as LlmMessagesClient,
        maxCostUsd: 0.001,
        maxTurns: 10,
      }),
    );

    expect(result.status).toBe("halted");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("escalates a tool result after the same call fails REPEAT_FAILURE_LIMIT (3) times", async () => {
    // Model stubbornly re-issues the identical failing call, then finishes blocked.
    const failingCall = () => makeCompletion(null, [toolCall("tc_wait", "browser__wait_for", { selector: "table tbody tr" })]);
    const create = vi
      .fn()
      .mockResolvedValueOnce(failingCall())
      .mockResolvedValueOnce(failingCall())
      .mockResolvedValueOnce(failingCall())
      .mockResolvedValueOnce(finishTaskCompletion("blocked", "Selector never appears."));
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Timeout exceeded" }], isError: true });

    const result = await runAgentLoop(
      baseOptions({
        llmClient: { chat: { completions: { create } } } as unknown as LlmMessagesClient,
        mcpClientManager: fakeMcpManager(callTool),
        maxTurns: 10,
      }),
    );

    expect(result.status).toBe("blocked");
    // messages array is shared/mutated, so use fixed indices captured by order:
    // [0 system, 1 user, 2 asst, 3 tool(fail1), 4 asst, 5 tool(fail2), 6 asst, 7 tool(fail3=escalated)]
    const finalMessages = (create.mock.calls[3]![0] as OpenAI.ChatCompletionCreateParamsNonStreaming).messages;
    expect(String(finalMessages[7]!.content)).toMatch(/failed every time/); // 3rd failure escalated
    expect(String(finalMessages[3]!.content)).not.toMatch(/failed every time/); // 1st failure not
  });

  it("does not crash on a tool call with malformed JSON arguments; surfaces a recoverable error", async () => {
    const create = vi
      .fn()
      // Arguments string is invalid JSON (unterminated) -- must not throw.
      .mockResolvedValueOnce(makeCompletion(null, [rawToolCall("tc_bad", "browser__eval", '{"expression": "foo(\\"}')]))
      .mockResolvedValueOnce(finishTaskCompletion("success", "Recovered.", PASSING_VERIFICATION));
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const result = await runAgentLoop(
      baseOptions({
        llmClient: { chat: { completions: { create } } } as unknown as LlmMessagesClient,
        mcpClientManager: fakeMcpManager(callTool),
      }),
    );

    expect(result.status).toBe("success");
    // The malformed call was never executed...
    expect(callTool).not.toHaveBeenCalledWith("browser__eval", expect.anything());
    // ...and the model got an error tool result telling it the args were invalid.
    const secondCallArgs = create.mock.calls[1]![0] as OpenAI.ChatCompletionCreateParamsNonStreaming;
    expect(String(secondCallArgs.messages[3]!.content)).toMatch(/not valid JSON/);
  });

  it("nudges a model that responds with no tool call, and eventually halts if it never recovers", async () => {
    const create = vi.fn().mockResolvedValue(makeCompletion("thinking out loud, no action", []));

    const result = await runAgentLoop(
      baseOptions({
        llmClient: { chat: { completions: { create } } } as unknown as LlmMessagesClient,
        maxTurns: 2,
      }),
    );

    expect(result.status).toBe("halted");
    expect(create).toHaveBeenCalledTimes(2);

    // messages at second call: [system, user, assistant(text-only), user(nudge)]
    const secondCallArgs = create.mock.calls[1]![0] as OpenAI.ChatCompletionCreateParamsNonStreaming;
    const nudgeMessage = secondCallArgs.messages[3]!;
    expect(String(nudgeMessage.content)).toMatch(/Continue the task, or call finish_task/);
  });
});
