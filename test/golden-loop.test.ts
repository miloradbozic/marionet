import { createServer, type Server } from "node:http";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type OpenAI from "openai";
import { runAgentLoop, type LlmMessagesClient } from "../src/loop/agent-loop.js";
import { McpClientManager } from "../src/mcp/mcp-client-manager.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { RunLogger } from "../src/logging/run-logger.js";
import { parseEvents } from "../src/compiler/trajectory.js";
import { compileRun } from "../src/compiler/compile.js";
import { writeSkillFiles } from "../src/compiler/emit.js";
import type { Segmenter } from "../src/compiler/segment.js";
import { SkillStore } from "../src/replay/skill-store.js";
import { replaySkill } from "../src/replay/replay-engine.js";
import type { Healer } from "../src/replay/heal.js";
import type { Skill } from "../src/compiler/skill.types.js";

/**
 * The golden loop -- the product thesis as a test (DESIGN.md, Testing #3):
 *
 *   explore once (agent loop, scripted model, real browser + real MCP server)
 *   -> compile into skills (stub segmenter, real pipeline)
 *   -> replay with different parameters, asserting ZERO llm calls
 *   -> mutate the site (button class, id, and text all change)
 *   -> self-heal patches the skill and the run passes its post-condition
 *   -> replay again: zero LLM calls, the heal stuck.
 *
 * Uses the installed Google Chrome (channel "chrome") headless over CDP --
 * the same attach path production uses -- and spawns the real browser MCP
 * server as a stdio subprocess. Skipped when Chrome isn't installed.
 */

let chromeAvailable = true;
try {
  execSync("google-chrome --version", { stdio: "ignore" });
} catch {
  chromeAvailable = false;
}

const repoRoot = path.resolve(__dirname, "..");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function makeCompletion(toolCalls: Array<{ id: string; name: string; input: unknown }>): OpenAI.ChatCompletion {
  return {
    id: "chatcmpl_scripted",
    object: "chat.completion",
    created: 0,
    model: "scripted",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
          refusal: null,
        },
        finish_reason: "tool_calls",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

describe.skipIf(!chromeAvailable)("golden loop (integration)", () => {
  let server: Server;
  let baseUrl = "";
  let variant = "app.html"; // the test flips this to app.v2.html to simulate a redeploy
  let browser: Browser;
  let mcp: McpClientManager;
  let policy: PolicyEngine;
  let runsRoot: string;
  let skillsDir: string;

  beforeAll(async () => {
    // Static server for test-site/, with a switchable "deploy" at /app.
    const sitePort = await freePort();
    server = createServer((req, res) => {
      const file = req.url === "/app" ? variant : (req.url ?? "/").slice(1) || "app.html";
      try {
        const html = readFileSync(path.join(repoRoot, "test-site", file));
        res.writeHead(200, { "content-type": "text/html" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    await new Promise<void>((r) => server.listen(sitePort, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${sitePort}`;

    // Headless Chrome with a CDP endpoint, attached the same way production is.
    const cdpPort = await freePort();
    browser = await chromium.launch({ channel: "chrome", headless: true, args: [`--remote-debugging-port=${cdpPort}`] });

    mcp = await McpClientManager.connectAll(
      [{ name: "browser", command: "npx", args: ["tsx", "mcp-servers/browser/src/server.ts"] }],
      repoRoot,
      `http://127.0.0.1:${cdpPort}`,
    );

    policy = new PolicyEngine(path.join(repoRoot, "config", "policy.json5"));
    runsRoot = mkdtempSync(path.join(os.tmpdir(), "marionet-golden-runs-"));
    skillsDir = mkdtempSync(path.join(os.tmpdir(), "marionet-golden-skills-"));
  }, 60_000);

  afterAll(async () => {
    await mcp?.closeAll();
    await browser?.close();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  const TASK = "Open product 1001 in the demo PIM and set the EAN attribute to 4006381333931";

  function makeLogger(task: string): RunLogger {
    return new RunLogger(runsRoot, {
      task,
      model: "scripted",
      maxTurns: 20,
      maxCostUsd: 0,
      policySnapshot: policy.snapshot,
      policySourcePath: policy.sourcePath,
    });
  }

  const stubSegmenter: Segmenter = async () => ({
    flowName: "set_ean_for_product",
    flowDescription: "Open a product by SKU and set its EAN.",
    paramNames: { "1001": "sku", "4006381333931": "ean" },
    segments: [
      {
        name: "open_product_by_sku",
        description: "Search the grid for a SKU and open the product page.",
        firstStep: 0,
        lastStep: 3,
        postCondition: {
          tool: "browser__eval",
          args: { expression: "location.hash.indexOf('#/product/') !== -1" },
          expectPattern: "true",
        },
      },
      { name: "set_product_ean", description: "Set the EAN field and save.", firstStep: 4, lastStep: 5 },
    ],
    playbookNotes: ["Grid search fires only on Enter, not on input."],
  });

  let store: SkillStore;

  it("explores once and compiles the run into parameterized skills with semantic locators", async () => {
    const script = [
      makeCompletion([{ id: "t1", name: "browser__navigate", input: { url: `${baseUrl}/app` } }]),
      makeCompletion([{ id: "t2", name: "browser__fill", input: { selector: 'input[placeholder="Search products"]', value: "1001" } }]),
      makeCompletion([{ id: "t3", name: "browser__press", input: { key: "Enter", selector: 'input[placeholder="Search products"]' } }]),
      makeCompletion([{ id: "t4", name: "browser__click_text", input: { text: "1001" } }]),
      makeCompletion([{ id: "t5", name: "browser__fill", input: { selector: "#ean-field", value: "4006381333931" } }]),
      makeCompletion([{ id: "t6", name: "browser__click", input: { selector: ".sc-abc123" } }]),
      makeCompletion([
        {
          id: "t7",
          name: "finish_task",
          input: {
            status: "success",
            summary: "EAN set on product 1001.",
            verification: {
              tool: "browser__eval",
              args: { expression: "document.querySelector('#ean-field').value" },
              expectPattern: "4006381333931",
            },
          },
        },
      ]),
    ];
    const llmClient = {
      chat: { completions: { create: vi.fn(async () => script.shift()!) } },
    } as unknown as LlmMessagesClient;

    const logger = makeLogger(TASK);
    const result = await runAgentLoop({
      task: TASK,
      model: "scripted",
      maxTokens: 4096,
      maxTurns: 20,
      maxCostUsd: 0,
      llmClient,
      mcpClientManager: mcp,
      policy,
      logger,
    });
    logger.finalize(result.status);
    expect(result.status).toBe("success");

    // Compile the run's events into skills.
    const events = parseEvents(readFileSync(path.join(logger.runDir, "events.jsonl"), "utf-8"));
    const compiled = await compileRun({
      events,
      runId: logger.runId,
      task: TASK,
      model: "scripted",
      metaStatus: "success",
      segmenter: stubSegmenter,
    });

    expect(compiled.fallbackReason).toBeUndefined();
    expect(compiled.primitives.map((p) => p.name)).toEqual(["open_product_by_sku", "set_product_ean"]);
    expect(compiled.flow?.name).toBe("set_ean_for_product");

    // Acceptance: sku parameterized in the open skill.
    const open = compiled.primitives[0]!;
    expect(open.params).toEqual([{ name: "sku", example: "1001" }]);
    expect(JSON.stringify(open.steps)).toContain("{{sku}}");

    // The live run captured the save button's semantic identity through the
    // real MCP server; the compiler lifted it into a locator.
    const set = compiled.primitives[1]!;
    const clickStep = set.steps.find((s) => s.tool === "browser__click")!;
    expect(clickStep.locator).toEqual({ role: "button", name: "Save" });
    expect(set.postCondition.expectPattern).toBe("{{ean}}");

    writeSkillFiles(skillsDir, compiled);
    store = new SkillStore(skillsDir);
    expect(store.listNames().sort()).toEqual(["open_product_by_sku", "set_ean_for_product", "set_product_ean"]);
  }, 90_000);

  it("replays the flow with different parameters and zero LLM calls", async () => {
    const logger = makeLogger("replay set_ean_for_product sku=2002");
    const r = await replaySkill("set_ean_for_product", { sku: "2002", ean: "9999999999" }, { store, mcp, policy, logger });
    logger.finalize(r.status);

    expect(r.status).toBe("success");
    expect(r.llmCalls).toBe(0); // learn once, replay cheap
    expect(r.healsApplied).toBe(0);
    expect(r.primitivesRun).toEqual(["open_product_by_sku", "set_product_ean"]);
  }, 90_000);

  it("self-heals when the site redeploys, and the patch sticks for future replays", async () => {
    variant = "app.v2.html"; // the redeploy: save button class, id, and text all changed

    const healer: Healer = vi.fn(async (input) => {
      // The healer sees the fresh page: the button is now "Save changes".
      expect(input.snapshot).toContain("Save changes");
      expect(input.step.tool).toBe("browser__click");
      return { tool: "browser__click", args: { role: "button", name: "Save changes" } };
    });

    const loggerHeal = makeLogger("replay set_ean_for_product sku=1001 (post-redeploy)");
    const healed = await replaySkill("set_ean_for_product", { sku: "1001", ean: "5555555555" }, { store, mcp, policy, logger: loggerHeal, healer });
    loggerHeal.finalize(healed.status);

    expect(healed.status).toBe("success"); // post-condition passed despite the redeploy
    expect(healed.healsApplied).toBe(1);
    expect(healed.llmCalls).toBe(1); // the LLM woke up for exactly the broken step

    // The patch was persisted into the skill file...
    const onDisk = JSON.parse(readFileSync(store.pathOf("set_product_ean"), "utf-8")) as Skill;
    expect(onDisk.steps.find((s) => s.tool === "browser__click")!.args).toEqual({ role: "button", name: "Save changes" });

    // ...so the next replay needs no LLM at all.
    const loggerAfter = makeLogger("replay set_ean_for_product sku=3003 (after heal)");
    const after = await replaySkill("set_ean_for_product", { sku: "3003", ean: "7777777777" }, { store, mcp, policy, logger: loggerAfter });
    loggerAfter.finalize(after.status);

    expect(after.status).toBe("success");
    expect(after.llmCalls).toBe(0);
    expect(after.healsApplied).toBe(0);
  }, 120_000);
});
