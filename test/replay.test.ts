import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SkillStore } from "../src/replay/skill-store.js";
import { readOnlyPrefix, replaySkill, resolvePlan, warmUpSkill, type ReplayEngineOptions } from "../src/replay/replay-engine.js";
import { substituteArgs, substitutePattern, substituteString, ParamError } from "../src/replay/params.js";
import { validatePatch, HealError, type Healer } from "../src/replay/heal.js";
import { healCount, REEXPLORE_HEAL_THRESHOLD, renderLineage, type LineageEntry, type Skill, type FlowSkill } from "../src/compiler/skill.types.js";
import type { McpClientManager, McpToolResult } from "../src/mcp/mcp-client-manager.js";
import type { PolicyEngine } from "../src/policy/policy-engine.js";
import type { RunLogger } from "../src/logging/run-logger.js";

const SOURCE = { runId: "r", task: "t", model: "m", compiledAt: "2026-07-02T00:00:00Z" };

function makeStore(skills: Array<Skill | FlowSkill>, expectedClient?: string): SkillStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), "marionet-skills-"));
  const store = new SkillStore(dir, expectedClient);
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
      { type: "function", function: { name: "browser__extract" } },
      { type: "function", function: { name: "browser__navigate" } },
      { type: "function", function: { name: "browser__snapshot" } },
    ],
    callTool: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      return handler(tool, args);
    },
  } as unknown as McpClientManager;
  const policy = { evaluate: () => ({ action: "allow", matchedRule: { match: "*", action: "allow" } }) } as unknown as PolicyEngine;
  const events: Array<Record<string, unknown>> = [];
  const logger = { runId: "test-run", log: (e: Record<string, unknown>) => events.push(e) } as unknown as RunLogger;
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

describe("tenant isolation", () => {
  it("loads a skill whose client stamp matches the store's expected client", () => {
    const store = makeStore([{ ...openSkill, client: "opari" }], "opari");
    expect(store.load("open_thing").client).toBe("opari");
  });

  it("loads an unscoped skill from an unscoped store", () => {
    const store = makeStore([openSkill], undefined);
    expect(store.load("open_thing").client).toBeUndefined();
  });

  it("refuses to load a skill stamped for a different client", () => {
    const store = makeStore([{ ...openSkill, client: "opari" }], "other-client");
    expect(() => store.load("open_thing")).toThrow(/tenant isolation/);
  });

  it("refuses to load a client-owned skill from an unscoped store", () => {
    const store = makeStore([{ ...openSkill, client: "opari" }], undefined);
    expect(() => store.load("open_thing")).toThrow(/tenant isolation/);
  });

  it("refuses to load an unscoped skill from a client-scoped store", () => {
    const store = makeStore([openSkill], "opari");
    expect(() => store.load("open_thing")).toThrow(/tenant isolation/);
  });

  it("blocks a flow from pulling in another client's primitive during resolvePlan", () => {
    const store = makeStore(
      [
        { ...openSkill, client: "opari" },
        { ...editSkill, client: "other-client" },
        { ...flow, client: "opari" },
      ],
      "opari",
    );
    expect(() => resolvePlan(store, "open_and_set", { id: "7", value: "x" })).toThrow(/tenant isolation/);
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
    // The last post-condition's read is returned -- how read-only skills yield data.
    expect(r.finalRead).toBe('"abc"');
    expect(r.summary).toContain('post-condition read: "abc"');
  });

  it("fails the replay when a post-condition does not match", async () => {
    const store = makeStore([editSkill]);
    const { mcp, policy, logger } = makeMocks((tool) =>
      tool === "browser__eval" ? okResult('"WRONG"') : okResult("Filled"),
    );
    const r = await replaySkill("set_value", { value: "abc" }, { store, mcp, policy, logger, postRetryDelayMs: 0 });
    expect(r.status).toBe("failure");
    expect(r.summary).toContain("post-condition");
  });

  it("skips predecessors when a later primitive's skipIf already holds (backward scan)", async () => {
    const openWithSkipIf: Skill = {
      ...openSkill,
      skipIf: { tool: "browser__eval", args: { expression: "probe_open" }, expectPattern: "#/thing/{{id}}" },
    };
    const store = makeStore([openWithSkipIf, editSkill, flow]);
    const { mcp, policy, logger, calls } = makeMocks((tool, args) => {
      if (tool === "browser__eval" && args.expression === "probe_open") return okResult("#/thing/777");
      if (tool === "browser__eval") return okResult('"abc"');
      return okResult("Filled");
    });

    const r = await replaySkill("open_and_set", { id: "777", value: "abc" }, { store, mcp, policy, logger });

    expect(r.status).toBe("success");
    expect(r.primitivesSkipped).toEqual(["open_thing"]);
    expect(r.primitivesRun).toEqual(["set_value"]);
    expect(r.stepsExecuted).toBe(1);
    // The thing was never re-opened: no fill of the search box.
    expect(calls.some((c) => c.tool === "browser__fill" && c.args.selector === "#search")).toBe(false);
    expect(r.summary).toContain("skipped open_thing");
  });

  it("runs everything when skipIf does not match", async () => {
    const openWithSkipIf: Skill = {
      ...openSkill,
      skipIf: { tool: "browser__eval", args: { expression: "probe_open" }, expectPattern: "#/thing/{{id}}" },
    };
    const store = makeStore([openWithSkipIf, editSkill, flow]);
    const { mcp, policy, logger } = makeMocks((tool, args) => {
      if (tool === "browser__eval" && args.expression === "probe_open") return okResult("#/somewhere/else");
      if (tool === "browser__eval" && String(args.expression).includes("location.hash")) return okResult("#/thing/777");
      if (tool === "browser__eval") return okResult('"abc"');
      return okResult("Filled");
    });

    const r = await replaySkill("open_and_set", { id: "777", value: "abc" }, { store, mcp, policy, logger });

    expect(r.status).toBe("success");
    expect(r.primitivesSkipped).toEqual([]);
    expect(r.primitivesRun).toEqual(["open_thing", "set_value"]);
    expect(r.stepsExecuted).toBe(2);
  });

  it("returns the skipIf read as finalRead when the whole skill is already satisfied", async () => {
    const readSkill: Skill = {
      ...openSkill,
      name: "read_thing",
      params: [],
      skipIf: { tool: "browser__eval", args: { expression: "probe_value" }, expectPattern: "[\\s\\S]*" },
      steps: [{ tool: "browser__fill", args: { selector: "#search", value: "x" } }],
    };
    const store = makeStore([readSkill]);
    const { mcp, policy, logger } = makeMocks(() => okResult('"12345"'));

    const r = await replaySkill("read_thing", {}, { store, mcp, policy, logger });

    expect(r.status).toBe("success");
    expect(r.stepsExecuted).toBe(0);
    expect(r.finalRead).toBe('"12345"');
    expect(r.summary).toContain("nothing to do");
  });

  it("retries a post-condition read that races a slow render", async () => {
    const store = makeStore([editSkill]);
    let reads = 0;
    const { mcp, policy, logger, calls } = makeMocks((tool) => {
      if (tool !== "browser__eval") return okResult("Filled");
      reads++;
      return reads === 1 ? okResult("Loading...") : okResult('"abc"');
    });
    const r = await replaySkill("set_value", { value: "abc" }, { store, mcp, policy, logger, postRetryDelayMs: 0 });
    expect(r.status).toBe("success");
    expect(calls.filter((c) => c.tool === "browser__eval").length).toBe(2);
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

describe("lineage", () => {
  const healingMocks = () =>
    makeMocks((tool, args) => {
      if (tool === "browser__fill" && args.selector === "#value") return errResult("selector not found");
      if (tool === "browser__fill" && args.role === "textbox") return okResult("Filled");
      if (tool === "browser__snapshot") return okResult('e1 textbox "Value"');
      if (tool === "browser__eval") return okResult('"fixed"');
      return okResult("ok");
    });
  const healer: Healer = async () => ({ tool: "browser__fill", args: { role: "textbox", name: "Value", value: "{{value}}" } });

  it("appends a typed heal entry to the skill's lineage, preserving the explored root", async () => {
    const explored: LineageEntry = { type: "explored", at: "2026-07-02T00:00:00Z", note: "explored from run r (verified)", runId: "r" };
    const store = makeStore([{ ...editSkill, lineage: [explored] }]);
    const { mcp, policy, logger } = healingMocks();

    const r = await replaySkill("set_value", { value: "fixed" }, { store, mcp, policy, logger, healer });

    expect(r.status).toBe("success");
    const onDisk = JSON.parse(readFileSync(store.pathOf("set_value"), "utf-8")) as Skill;
    expect(onDisk.lineage).toHaveLength(2);
    expect(onDisk.lineage![0]).toEqual(explored); // the root is never rewritten
    expect(onDisk.lineage![1]!.type).toBe("heal");
    expect(onDisk.lineage![1]!.stepIndex).toBe(0);
    expect(onDisk.lineage![1]!.runId).toBe("test-run");
    expect(onDisk.lineage![1]!.note).toContain("healed");
  });

  it("proposes re-exploration once the chain reaches the heal threshold", async () => {
    const priorHeals: LineageEntry[] = [
      { type: "explored", at: "2026-07-02T00:00:00Z", note: "explored from run r (verified)" },
      ...Array.from({ length: REEXPLORE_HEAL_THRESHOLD - 1 }, (_, i) => ({
        type: "heal" as const,
        at: "2026-07-03T00:00:00Z",
        note: `step 0 healed earlier (#${i + 1})`,
      })),
    ];
    const store = makeStore([{ ...editSkill, lineage: priorHeals }]);
    const { mcp, policy, logger, events } = healingMocks();

    const r = await replaySkill("set_value", { value: "fixed" }, { store, mcp, policy, logger, healer });

    expect(r.status).toBe("success");
    expect(r.reExploreProposed).toEqual(["set_value"]);
    expect(r.summary).toContain("re-explore proposed");
    const proposal = events.find((e) => e.type === "reexplore_proposed");
    expect(proposal).toMatchObject({ skill: "set_value", heals: REEXPLORE_HEAL_THRESHOLD });
  });

  it("stays quiet below the threshold", async () => {
    const store = makeStore([editSkill]); // no prior lineage: this is heal #1
    const { mcp, policy, logger, events } = healingMocks();

    const r = await replaySkill("set_value", { value: "fixed" }, { store, mcp, policy, logger, healer });

    expect(r.healsApplied).toBe(1);
    expect(r.reExploreProposed).toEqual([]);
    expect(events.some((e) => e.type === "reexplore_proposed")).toBe(false);
  });

  it("renders a chain and counts only heals", () => {
    const lineage: LineageEntry[] = [
      { type: "explored", at: "t", note: "explored from run r (verified)" },
      { type: "heal", at: "t", note: "step 0 healed" },
      { type: "human", at: "t", note: "step 2 patched by hand" },
    ];
    expect(renderLineage(lineage)).toBe("explored from run r (verified) -> step 0 healed -> step 2 patched by hand");
    expect(healCount(lineage)).toBe(1);
    expect(renderLineage(undefined)).toContain("no lineage");
    expect(healCount(undefined)).toBe(0);
  });
});

describe("warm-up prefix", () => {
  const navSkill: Skill = {
    kind: "primitive",
    name: "nav_and_write",
    description: "navigate, look, then write",
    params: [{ name: "id", example: "42" }],
    steps: [
      { tool: "browser__navigate", args: { url: "https://example.test/{{id}}" } },
      { tool: "browser__extract", args: { selector: "#title", format: "text" } },
      { tool: "browser__fill", args: { selector: "#value", value: "x" } },
      { tool: "browser__extract", args: { selector: "#after", format: "text" } },
    ],
    postCondition: { tool: "browser__extract", args: { selector: "#value", format: "value" }, expectPattern: "x" },
    source: SOURCE,
  };

  it("takes the leading read-only steps and stops at the first write", () => {
    const store = makeStore([navSkill]);
    const plan = resolvePlan(store, "nav_and_write", { id: "42" });
    const prefix = readOnlyPrefix(plan);
    // navigate + extract, stopping before the fill -- the trailing extract
    // after the write is NOT part of the prefix.
    expect(prefix.map((p) => p.step.tool)).toEqual(["browser__navigate", "browser__extract"]);
  });

  it("is empty when the skill writes immediately (nothing safe to pre-flight)", () => {
    const store = makeStore([editSkill]);
    const plan = resolvePlan(store, "set_value", { value: "v" });
    expect(readOnlyPrefix(plan)).toEqual([]);
  });

  it("executes only the read-only prefix and never the write", async () => {
    const store = makeStore([navSkill]);
    const { mcp, policy, logger, calls } = makeMocks(() => okResult("ok"));

    const w = await warmUpSkill("nav_and_write", { id: "42" }, { store, mcp, policy, logger });

    expect(w.ok).toBe(true);
    expect(w.stepsRun).toBe(2);
    expect(calls.map((c) => c.tool)).toEqual(["browser__navigate", "browser__extract"]);
    expect(calls.some((c) => c.tool === "browser__fill")).toBe(false);
    // Params reached the prefix.
    expect(calls[0]!.args.url).toBe("https://example.test/42");
  });

  it("reports failure when the prefix breaks -- the batch's abort signal", async () => {
    const store = makeStore([navSkill]);
    const { mcp, policy, logger } = makeMocks((tool) =>
      tool === "browser__navigate" ? errResult("net::ERR_CONNECTION_REFUSED") : okResult("ok"),
    );

    const w = await warmUpSkill("nav_and_write", { id: "42" }, { store, mcp, policy, logger });

    expect(w.ok).toBe(false);
    expect(w.summary).toContain("warm-up failed");
    expect(w.summary).toContain("browser__navigate");
  });

  it("succeeds trivially when there is no prefix to run", async () => {
    const store = makeStore([editSkill]);
    const { mcp, policy, logger, calls } = makeMocks(() => okResult("ok"));

    const w = await warmUpSkill("set_value", { value: "v" }, { store, mcp, policy, logger });

    expect(w.ok).toBe(true);
    expect(w.stepsRun).toBe(0);
    expect(calls).toEqual([]); // nothing executed: no write was risked
  });

  it("makes no LLM calls and heals nothing -- it only reports", async () => {
    const store = makeStore([navSkill]);
    const { mcp, policy, logger } = makeMocks((tool) =>
      tool === "browser__navigate" ? errResult("boom") : okResult("ok"),
    );
    const healer = vi.fn();
    const w = await warmUpSkill("nav_and_write", { id: "42" }, { store, mcp, policy, logger, healer: healer as unknown as Healer });
    expect(w.ok).toBe(false);
    expect(healer).not.toHaveBeenCalled();
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
