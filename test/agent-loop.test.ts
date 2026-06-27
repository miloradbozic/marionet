import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgentLoop, type MessagesClient } from "../src/loop/agent-loop.js";
import type { McpClientManager, McpToolResult } from "../src/mcp/mcp-client-manager.js";
import type { PolicyEngine } from "../src/policy/policy-engine.js";
import type { RunLogger } from "../src/logging/run-logger.js";
import type { PolicyDecision } from "../src/policy/policy.types.js";

function makeMessage(content: Anthropic.ContentBlock[]): Anthropic.Message {
  return {
    id: "msg_test",
    container: null,
    content,
    model: "claude-sonnet-4-6",
    role: "assistant",
    stop_details: null,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 100,
      output_tokens: 50,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null };
}

function toolUseBlock(id: string, name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } };
}

function finishTaskMessage(status: "success" | "failure" | "blocked", summary: string): Anthropic.Message {
  return makeMessage([toolUseBlock("toolu_finish", "finish_task", { status, summary })]);
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
  return { anthropicTools: [], callTool } as unknown as McpClientManager;
}

function baseOptions(overrides: Partial<Parameters<typeof runAgentLoop>[0]> = {}) {
  return {
    task: "do the thing",
    model: "claude-sonnet-4-6",
    maxTokens: 4096,
    maxTurns: 10,
    maxCostUsd: 10,
    anthropicClient: { messages: { create: vi.fn() } } as unknown as MessagesClient,
    mcpClientManager: fakeMcpManager(async () => ({ content: [{ type: "text", text: "ok" }] })),
    policy: fakePolicy("allow"),
    logger: fakeLogger(),
    ...overrides,
  };
}

describe("runAgentLoop", () => {
  it("ends the run as soon as finish_task is called", async () => {
    const create = vi.fn().mockResolvedValue(finishTaskMessage("success", "All done."));
    const result = await runAgentLoop(
      baseOptions({ anthropicClient: { messages: { create } } as unknown as MessagesClient }),
    );
    expect(result).toEqual({ status: "success", summary: "All done.", details: undefined });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("routes an allowed tool call through the MCP manager, then finishes on the next turn", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(makeMessage([toolUseBlock("toolu_1", "shell__exec", { command: "ls" })]))
      .mockResolvedValueOnce(finishTaskMessage("success", "Listed files."));
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "file1\nfile2" }] });

    const result = await runAgentLoop(
      baseOptions({
        anthropicClient: { messages: { create } } as unknown as MessagesClient,
        mcpClientManager: fakeMcpManager(callTool),
      }),
    );

    expect(callTool).toHaveBeenCalledWith("shell__exec", { command: "ls" });
    expect(result.status).toBe("success");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("never executes a tool the policy denies, and surfaces the denial as an error tool_result", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(makeMessage([toolUseBlock("toolu_1", "payments__charge_card", { amount: 100 })]))
      .mockResolvedValueOnce(finishTaskMessage("blocked", "Could not charge card -- denied."));
    const callTool = vi.fn();

    const result = await runAgentLoop(
      baseOptions({
        anthropicClient: { messages: { create } } as unknown as MessagesClient,
        mcpClientManager: fakeMcpManager(callTool),
        policy: fakePolicy("deny"),
      }),
    );

    expect(callTool).not.toHaveBeenCalled();
    expect(result.status).toBe("blocked");

    // the denial must have been reported back to the model as an error tool_result.
    // Note: `messages` is mutated in place across iterations and mock.calls stores a
    // reference, not a snapshot -- index by known position, not `.at(-1)`, which would
    // reflect the array's *final* state after the whole loop finishes.
    const secondCallArgs = create.mock.calls[1]![0] as Anthropic.MessageCreateParamsNonStreaming;
    const toolResultMessage = secondCallArgs.messages[2]!;
    const content = toolResultMessage.content as Anthropic.ToolResultBlockParam[];
    expect(content[0]!.is_error).toBe(true);
    expect(String(content[0]!.content)).toMatch(/Denied by policy/);
  });

  it("halts once the turn ceiling is exceeded, without calling finish_task", async () => {
    const create = vi.fn().mockResolvedValue(makeMessage([toolUseBlock("toolu_1", "shell__exec", { command: "ls" })]));

    const result = await runAgentLoop(
      baseOptions({
        anthropicClient: { messages: { create } } as unknown as MessagesClient,
        maxTurns: 1,
      }),
    );

    expect(result.status).toBe("halted");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("halts once the cost ceiling is exceeded", async () => {
    const create = vi.fn().mockResolvedValue(makeMessage([toolUseBlock("toolu_1", "shell__exec", { command: "ls" })]));

    const result = await runAgentLoop(
      baseOptions({
        anthropicClient: { messages: { create } } as unknown as MessagesClient,
        maxCostUsd: 0, // first response already costs > $0, so the second iteration must halt
        maxTurns: 10,
      }),
    );

    expect(result.status).toBe("halted");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("nudges a model that responds with no tool call, and eventually halts if it never recovers", async () => {
    const create = vi.fn().mockResolvedValue(makeMessage([textBlock("thinking out loud, no action")]));

    const result = await runAgentLoop(
      baseOptions({
        anthropicClient: { messages: { create } } as unknown as MessagesClient,
        maxTurns: 2,
      }),
    );

    expect(result.status).toBe("halted");
    // first call: text-only -> nudge. Second call: text-only again -> nudges (2) + iter (2) > maxTurns (2) -> halt.
    expect(create).toHaveBeenCalledTimes(2);
    const secondCallArgs = create.mock.calls[1]![0] as Anthropic.MessageCreateParamsNonStreaming;
    const nudgeMessage = secondCallArgs.messages[2]!; // index by position -- see note in the test above
    expect(String(nudgeMessage.content)).toMatch(/Continue the task, or call finish_task/);
  });
});
