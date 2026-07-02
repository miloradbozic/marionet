import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SkillStore } from "../src/replay/skill-store.js";
import { replaySkill, resolvePlan, type ReplayEngineOptions } from "../src/replay/replay-engine.js";
import { substituteArgs, substitutePattern, substituteString, ParamError } from "../src/replay/params.js";
import { validatePatch, HealError, type Healer } from "../src/replay/heal.js";
import type { Skill, FlowSkill } from "../src/compiler/skill.types.js";
import type { McpClientManager, McpToolResult } from "../src/mcp/mcp-client-manager.js";
import type { PolicyEngine } from "../src/policy/policy-engine.js";
import type { RunLogger } from "../src/logging/run-logger.js";

const SOURCE = { runId: "r", task: "t", model: "m", compiledAt: "2026-07-02T00:00:00Z" };

function makeStore(skills: Array<Skill | FlowSkill>): SkillStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), "marionet-skills-"));
  const store = new SkillStore(dir);
  for (const s of skills) store.save(s);
  return store;
}

function okResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

function errResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

interface MockCall {
  tool: string;
  args: Record<string, unknown>;
}

function makeMocks(handler: (tool: string, args: Record<string, unknown>) => McpToolResult) {
  const calls: MockCall[] = [];
  const mcp = {
    tools: [
      { type: "function", function: { name: "browser__fill" } },
      { type: "function", function: { name: "browser__click" } },
      { type: "function", function: { name: "browser__eval" } },
      { type: "function", function: { name: "browser__snapshot" } },
    ],
    callTool: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      return handler(tool, args);
    },
  } as unknown as McpClientManager;
  const policy = { evaluate: () => ({ action: "allow", matchedRule: { match: "*", action: "allow" } }) } as unknown as PolicyEngine;
  const events: Array<Record<string, unknown>> = [];
  const logger = { log: (e: Record<string, unknown>) => events.push(e) } as unknown as RunLogger;
  return { mcp, policy, logger, calls, events };
}

const openSkill: Skill = {
  kind: "primitive",
  name: "open_thing",
  description: "open a thing by id",
  params: [{ name: "id", example: "42" }],
  steps: [{ tool: "browser__fill", args: { selector: "#search", value: "{{id}}" } }],
  postCondition: { tool: "browser__eval", args: { expression: "location.hash" }, expectPattern: "#/thing/" },
  source: SOURCE,
};

const editSkill: Skill = {
  kind: "primitive",
  name: "set_value",
  description: "set the value field",
  params: [{ name: "value", example: "99" }],
  steps: [{ tool: "browser__fill", args: { selector: "#value", value: "{{value}}" } }],
  postCondition: { tool: "browser__eval", args: { expression: "q('#value').value" }, expectPattern: "{{value}}" },
  source: SOURCE,
};

const flow: FlowSkill = {
  kind: "flow",
  name: "open_and_set",
  description: "open then set",
  params: [
    { name: "id", example: "42" },
    { name: "value", example: "99" },
  ],
  calls: [
    { skill: "open_thing", params: { id: "{{id}}" } },
    { skill: "set_value", params: { value: "{{value}}" } },
  ],
  source: SOURCE,
};

describe("param substitution", () => {
  it("substitutes placeholders and fails closed on missing params", () => {
    expect(substituteString("open {{id}} now", { id: "7" })).toBe("open 7 now");
    expect(() => substituteString("{{missing}}", {})).toThrow(ParamError);
    expect(substituteArgs({ a: "{{x}}", nested: { b: ["{{x}}"] } }, { x: "1" })).toEqual({ a: "1", nested: { b: ["1"] } });
  });

  it("regex-escapes values substituted into expectPattern", () => {
    const pattern = substitutePattern("^{{v}}$", { v: "a.b(c)" });
    expect(pattern).toBe("^a\\.b\\(c\\)$");
    expect(new RegExp(pattern).test("a.b(c)")).toBe(true);
    expect(new RegExp(pattern).test("aXb(c)")).toBe(false);
  });
});

describe("resolvePlan", () => {
  it("expands a flow into primitives with resolved params", () => {
    const store = makeStore([openSkill, editSkill, flow]);
    const plan = resolvePlan(store, "open_and_set", { id: "7", value: "x" });
    expect(plan.map((p) => p.skill.name)).toEqual(["open_thing", "set_value"]);
    // Param scoping: each primitive receives only its own params.
    expect(plan[0]!.params).toEqual({ id: "7" });
    expect(plan[1]!.params).toEqual({ value: "x" });
  });

  it("fails fast on missing params, naming what is required", () => {
    const store = makeStore([openSkill]);
    expect(() => resolvePlan(store, "open_thing", {})).toThrow(/missing parameter.*id/);
  });

  it("detects flow cycles", () => {
    const a: FlowSkill = { kind: "flow", name: "a", description: "", params: [], calls: [{ skill: "b", params: {} }], source: SOURCE };
    const b: FlowSkill = { kind: "flow", name: "b", description: "", params: [], calls: [{ skill: "a", params: {} }], source: SOURCE };
    const store = makeStore([a, b]);
    expect(() => resolvePlan(store, "a", {})).toThrow(/cycle/);
  });
});

describe("replaySkill happy path", () => {
  it("replays a flow with zero LLM calls and checks every post-condition", async () => {
    const store = makeStore([openSkill, editSkill, flow]);
    const { mcp, policy, logger, calls } = makeMocks((tool, args) => {
      if (tool === "browser__eval" && String(args.expression).includes("location.hash")) return okResult("#/thing/777");
      if (tool === "browser__eval") return okResult('"abc"');
      return okResult("Filled");
    });

    const r = await replaySkill("open_and_set", { id: "777", value: "abc" }, { store, mcp, policy, logger });

    expect(r.status).toBe("success");
    expect(r.llmCalls).toBe(0); // the product thesis
    expect(r.healsApplied).toBe(0);
    expect(r.stepsExecuted).toBe(2);
    expect(r.primitivesRun).toEqual(["open_thing", "set_value"]);
    // Params were substituted into the executed args.
    expect(calls[0]).toEqual({ tool: "browser__fill", args: { selector: "#search", value: "777" } });
    // Both post-conditions executed.
    expect(calls.filter((c) => c.tool === "browser__eval").length).toBe(2);
  });

  it("fails the replay when a post-condition does not match", async () => {
    const store = makeStore([editSkill]);
    const { mcp, policy, logger } = makeMocks((tool) =>
      tool === "browser__eval" ? okResult('"WRONG"') : okResult("Filled"),
    );
    const r = await replaySkill("set_value", { value: "abc" }, { store, mcp, policy, logger });
    expect(r.status).toBe("failure");
    expect(r.summary).toContain("post-condition");
  });

  it("returns blocked when policy denies a step", async () => {
    const store = makeStore([editSkill]);
    const { mcp, logger } = makeMocks(() => okResult("ok"));
    const policy = { evaluate: () => ({ action: "deny", matchedRule: { match: "*", action: "deny" } }) } as unknown as PolicyEngine;
    const r = await replaySkill("set_value", { value: "x" }, { store, mcp, policy, logger });
    expect(r.status).toBe("blocked");
  });
});

describe("semantic-first targeting", () => {
  const semanticSkill: Skill = {
    ...editSkill,
    name: "set_value_semantic",
    steps: [
      {
        tool: "browser__fill",
        args: { selector: ".css-1x2y3z input", value: "{{value}}" },
        locator: { role: "textbox", name: "Value" },
      },
    ],
  };

  it("tries role+name first and does not fall back when it works", async () => {
    const store = makeStore([semanticSkill]);
    const { mcp, policy, logger, calls } = makeMocks((tool) =>
      tool === "browser__eval" ? okResult('"v1"') : okResult("Filled"),
    );
    const r = await replaySkill("set_value_semantic", { value: "v1" }, { store, mcp, policy, logger });
    expect(r.status).toBe("success");
    expect(calls[0]!.args).toEqual({ role: "textbox", name: "Value", value: "v1" });
    expect(calls.filter((c) => c.tool === "browser__fill").length).toBe(1);
  });

  it("falls back to the recorded selector when semantic targeting fails", async () => {
    const store = makeStore([semanticSkill]);
    const { mcp, policy, logger, calls } = makeMocks((tool, args) => {
      if (tool === "browser__fill" && args.role) return errResult("no role match");
      if (tool === "browser__eval") return okResult('"v1"');
      return okResult("Filled");
    });
    const r = await replaySkill("set_value_semantic", { value: "v1" }, { store, mcp, policy, logger });
    expect(r.status).toBe("success");
    expect(calls[0]!.args.role).toBe("textbox");
    expect(calls[1]!.args.selector).toBe(".css-1x2y3z input");
  });
});

describe("self-heal", () => {
  it("wakes the healer on step failure, applies the patch, and persists it", async () => {
    const store = makeStore([editSkill]);
    const { mcp, policy, logger, calls, events } = makeMocks((tool, args) => {
      if (tool === "browser__fill" && args.selector === "#value") return errResult("selector not found");
      if (tool === "browser__fill" && args.role === "textbox") return okResult("Filled");
      if (tool === "browser__snapshot") return okResult('e1 textbox "Value"');
      if (tool === "browser__eval") return okResult('"fixed"');
      return okResult("ok");
    });
    const healer: Healer = vi.fn(async () => ({
      tool: "browser__fill",
      args: { role: "textbox", name: "Value", value: "{{value}}" },
    }));

    const r = await replaySkill("set_value", { value: "fixed" }, { store, mcp, policy, logger, healer });

    expect(r.status).toBe("success");
    expect(r.healsApplied).toBe(1);
    expect(r.llmCalls).toBe(1);
    expect(healer).toHaveBeenCalledOnce();
    // The healer saw the parameterized template, not the substituted value.
    const healInput = (healer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { step: { args: { value: string } }; snapshot: string };
    expect(healInput.step.args.value).toBe("{{value}}");
    expect(healInput.snapshot).toContain("textbox");
    // The patch was executed with substituted params...
    const healedCall = calls.find((c) => c.args.role === "textbox");
    expect(healedCall?.args.value).toBe("fixed");
    // ...and persisted to the skill file, still parameterized.
    const onDisk = JSON.parse(readFileSync(store.pathOf("set_value"), "utf-8")) as Skill;
    expect(onDisk.steps[0]!.args).toEqual({ role: "textbox", name: "Value", value: "{{value}}" });
    expect(events.some((e) => e.type === "heal_applied")).toBe(true);
  });

  it("respects the heal budget and fails without a healer", async () => {
    const store = makeStore([editSkill]);
    const { mcp, policy, logger } = makeMocks((tool) =>
      tool === "browser__fill" ? errResult("nope") : okResult("ok"),
    );
    const r = await replaySkill("set_value", { value: "x" }, { store, mcp, policy, logger });
    expect(r.status).toBe("failure");
    expect(r.summary).toContain("set_value[0]");
  });
});

describe("validatePatch", () => {
  it("rejects unknown tools and missing args", () => {
    expect(() => validatePatch({ tool: "browser__teleport", args: {} }, ["browser__fill"])).toThrow(HealError);
    expect(() => validatePatch({ tool: "browser__fill" }, ["browser__fill"])).toThrow(HealError);
    expect(validatePatch({ tool: "browser__fill", args: { role: "textbox" } }, ["browser__fill"])).toEqual({
      tool: "browser__fill",
      args: { role: "textbox" },
    });
  });
});
