import path from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { loadRunConfig } from "./mcp/server-registry.js";
import { McpClientManager } from "./mcp/mcp-client-manager.js";
import { PolicyEngine } from "./policy/policy-engine.js";
import { RunLogger, type RunMeta } from "./logging/run-logger.js";
import { renderTranscript } from "./logging/transcript-renderer.js";
import { computeRunStats, renderRunStats } from "./logging/run-stats.js";
import { runAgentLoop } from "./loop/agent-loop.js";
import { createLlmClient } from "./llm-client.js";
import { compileRun } from "./compiler/compile.js";
import { llmSegmenter, monolithSegmenter, type Segmenter } from "./compiler/segment.js";
import { parseEvents } from "./compiler/trajectory.js";
import { writeSkillFiles, appendPlaybookNotes } from "./compiler/emit.js";
import { SkillStore } from "./replay/skill-store.js";
import { replaySkill } from "./replay/replay-engine.js";
import { llmHealer, type Healer } from "./replay/heal.js";
import type { SkillRunner } from "./loop/run-skill-tool.js";
import { isFlowSkill } from "./compiler/skill.types.js";
import {
  filterEnvForClient,
  loadClientProfile,
  renderClientPromptSection,
  type ClientProfile,
} from "./clients/client-profile.js";

async function isCdpReachable(cdpEndpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${cdpEndpoint}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureChrome(cdpEndpoint: string): Promise<void> {
  if (await isCdpReachable(cdpEndpoint)) return;

  console.log("Chrome not detected — starting Chrome...");
  const child = spawn(
    "google-chrome",
    ["--remote-debugging-port=9222", "--user-data-dir=/tmp/marionet-chrome"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  // Poll until CDP responds (up to 10s)
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isCdpReachable(cdpEndpoint)) return;
  }
  throw new Error(`Chrome did not become reachable at ${cdpEndpoint} after 10s`);
}

const USAGE =
  'Usage: marionet run [--client <name>] "<task>"\n' +
  "       marionet last [run-id]        (duration, cost, LLM turns, replay-or-not)\n" +
  "       marionet transcript [run-id]\n" +
  "       marionet compile [run-id] [--heuristic]\n" +
  "       marionet replay [--client <name>] <skill> [--param k=v ...] [--csv <file>] [--no-heal]\n" +
  "       marionet skills [--client <name>]";

function skillsDirFor(repoRoot: string, clientName: string | undefined): string {
  return clientName ? path.join(repoRoot, "clients", clientName, "skills") : path.join(repoRoot, "workspace", "skills");
}

async function runCommand(repoRoot: string, task: string, clientName: string | undefined): Promise<void> {
  const runConfig = loadRunConfig(path.join(repoRoot, "config", "run.config.json"));
  const profile: ClientProfile | undefined = clientName ? loadClientProfile(repoRoot, clientName) : undefined;
  const policy = new PolicyEngine(path.join(repoRoot, "config", "policy.json5"), profile?.policyPath);

  await ensureChrome(runConfig.browser.cdpEndpoint);

  mkdirSync(path.join(repoRoot, "runs"), { recursive: true });
  mkdirSync(path.join(repoRoot, "workspace"), { recursive: true });

  const logger = new RunLogger(path.join(repoRoot, "runs"), {
    task,
    client: profile?.name,
    model: runConfig.model,
    maxTurns: runConfig.maxTurns,
    maxCostUsd: runConfig.maxCostUsd,
    pricing: runConfig.pricing,
    policySnapshot: policy.snapshot,
    policySourcePath: policy.sourcePath,
  });

  console.log(`marionet run ${logger.runId}`);
  if (profile) console.log(`client: ${profile.name} (${profile.playbooks.length} playbook(s))`);
  console.log(`task: ${task}`);

  const mcpClientManager = await McpClientManager.connectAll(
    runConfig.mcpServers,
    repoRoot,
    runConfig.browser.cdpEndpoint,
    filterEnvForClient(process.env, profile),
  );

  const { client: llmClient, effectiveModel } = createLlmClient(runConfig.model);

  // Compiled skills become a run_skill tool: the agent can execute a
  // known-good flow in one call instead of rediscovering it step by step.
  const store = new SkillStore(skillsDirFor(repoRoot, profile?.name), profile?.name);
  const skillRunner: SkillRunner | undefined = store.listNames().length
    ? {
        available: () => store.list().map((s) => ({ name: s.name, description: s.description, params: s.params })),
        run: async (name, params) => {
          const r = await replaySkill(name, params, { store, mcp: mcpClientManager, policy, logger });
          return { status: r.status, summary: r.summary, finalVerification: r.finalVerification };
        },
      }
    : undefined;
  if (skillRunner) console.log(`skills: ${store.listNames().join(", ")}`);

  let exitCode = 1;
  try {
    const result = await runAgentLoop({
      task,
      model: effectiveModel,
      maxTokens: runConfig.maxTokens,
      maxTurns: runConfig.maxTurns,
      maxCostUsd: runConfig.maxCostUsd,
      supportsVision: runConfig.supportsVision ?? true,
      clientPromptSection: profile ? renderClientPromptSection(profile) : undefined,
      llmClient,
      pricing: runConfig.pricing,
      mcpClientManager,
      policy,
      logger,
      skillRunner,
    });

    logger.finalize(result.status);
    renderTranscript(logger.runDir);

    console.log(`\nstatus: ${result.status}`);
    console.log(result.summary);
    if (result.details) console.log(result.details);
    console.log("");
    console.log(renderRunStats(computeRunStats(logger.runDir)));
    console.log(`\nlog: ${logger.runDir}`);

    exitCode = result.status === "success" ? 0 : 1;
  } catch (err) {
    console.error("fatal error:", err);
  } finally {
    await mcpClientManager.closeAll();
    process.exit(exitCode);
  }
}

/** Run IDs are ISO-timestamp-prefixed, so a lexicographic sort is also chronological. */
function resolveRunDir(repoRoot: string, runId: string | undefined): string {
  const runsRoot = path.join(repoRoot, "runs");
  if (runId) {
    const dir = path.join(runsRoot, runId);
    if (!existsSync(dir)) throw new Error(`No run found at ${dir}`);
    return dir;
  }
  const entries = existsSync(runsRoot)
    ? readdirSync(runsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];
  const latest = entries.at(-1);
  if (!latest) throw new Error(`No runs found under ${runsRoot}`);
  return path.join(runsRoot, latest);
}

function lastCommand(repoRoot: string, runId: string | undefined): void {
  const runDir = resolveRunDir(repoRoot, runId);
  // Old runs predate the pricing snapshot in meta.json; fall back to the
  // currently-configured pricing so their cost is still estimable.
  let fallbackPricing: { input: number; output: number } | undefined;
  try {
    fallbackPricing = loadRunConfig(path.join(repoRoot, "config", "run.config.json")).pricing;
  } catch {
    /* no config -- tokens only */
  }
  console.log(renderRunStats(computeRunStats(runDir, fallbackPricing)));
}

function transcriptCommand(repoRoot: string, runId: string | undefined): void {
  const runDir = resolveRunDir(repoRoot, runId);
  // Re-renders from events.jsonl even if the run never reached a clean
  // finalize (Ctrl-C, crash) -- that's the whole point of this command.
  const markdown = renderTranscript(runDir);
  console.log(markdown);
  console.error(`\n(rendered from ${path.join(runDir, "events.jsonl")})`);
}

async function compileCommand(repoRoot: string, runId: string | undefined, useHeuristic: boolean): Promise<void> {
  const runDir = resolveRunDir(repoRoot, runId);
  const meta = JSON.parse(readFileSync(path.join(runDir, "meta.json"), "utf-8")) as RunMeta;
  const events = parseEvents(readFileSync(path.join(runDir, "events.jsonl"), "utf-8"));

  // Segmentation quality follows the model that recorded the run, so prefer
  // meta.model; fall back to the currently-configured model, then offline.
  let segmenter: Segmenter = monolithSegmenter;
  if (!useHeuristic) {
    const candidates = [meta.model];
    try {
      candidates.push(loadRunConfig(path.join(repoRoot, "config", "run.config.json")).model);
    } catch {
      /* no config -- meta.model only */
    }
    let lastErr: unknown;
    for (const model of candidates) {
      try {
        const { client, effectiveModel } = createLlmClient(model);
        segmenter = llmSegmenter(client, effectiveModel);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (segmenter === monolithSegmenter) {
      console.warn(
        `(no LLM available for segmentation: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}; compiling monolithically)`,
      );
    }
  }

  const result = await compileRun({
    events,
    runId: meta.runId,
    task: meta.task,
    model: meta.model,
    client: meta.client,
    metaStatus: meta.status,
    segmenter,
  });

  if (result.fallbackReason) {
    console.warn(`(LLM segmentation rejected: ${result.fallbackReason}; compiled monolithically)`);
  }

  const skillsDir = meta.client
    ? path.join(repoRoot, "clients", meta.client, "skills")
    : path.join(repoRoot, "workspace", "skills");
  const written = writeSkillFiles(skillsDir, result);
  for (const w of written) {
    const kindLabel = w.skill.kind === "flow" ? "flow" : "skill";
    console.log(`Compiled ${kindLabel} "${w.skill.name}" from run ${meta.runId}${w.overwrote ? " (overwrote existing)" : ""}`);
    console.log(`  params: ${w.skill.params.map((p) => `${p.name}=${p.example}`).join(", ") || "(none)"}`);
    if (w.skill.kind === "flow") {
      console.log(`  calls: ${w.skill.calls.map((c) => c.skill).join(" -> ")}`);
    } else {
      console.log(`  steps: ${w.skill.steps.length}, post-condition: ${w.skill.postCondition.tool}`);
    }
    console.log(`  -> ${w.path}`);
  }

  if (meta.client && result.playbookNotes.length) {
    const playbookPath = appendPlaybookNotes(repoRoot, meta.client, meta.runId, result.playbookNotes);
    if (playbookPath) console.log(`Playbook updated: ${playbookPath} (+${result.playbookNotes.length} note(s))`);
  }
}

/** Minimal CSV: first row = param names; commas split cells; surrounding quotes stripped. */
function parseCsv(filePath: string): Array<Record<string, string>> {
  const lines = readFileSync(filePath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error(`CSV ${filePath} needs a header row and at least one data row`);
  const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, "$1");
  const header = lines[0]!.split(",").map(unquote);
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map(unquote);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

interface ReplayCliArgs {
  skillName: string;
  clientName?: string;
  params: Record<string, string>;
  csvPath?: string;
  noHeal: boolean;
}

function parseReplayArgs(rest: string[]): ReplayCliArgs {
  const out: ReplayCliArgs = { skillName: "", params: {}, noHeal: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--client") {
      out.clientName = rest[++i];
      if (!out.clientName) throw new Error("--client requires a name");
    } else if (a === "--param") {
      const kv = rest[++i];
      const eq = kv?.indexOf("=") ?? -1;
      if (!kv || eq < 1) throw new Error("--param requires k=v");
      out.params[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === "--csv") {
      out.csvPath = rest[++i];
      if (!out.csvPath) throw new Error("--csv requires a file path");
    } else if (a === "--no-heal") {
      out.noHeal = true;
    } else if (!out.skillName) {
      out.skillName = a;
    } else {
      throw new Error(`unexpected argument "${a}"`);
    }
  }
  if (!out.skillName) throw new Error("replay requires a skill name");
  return out;
}

async function replayCommand(repoRoot: string, cliArgs: ReplayCliArgs): Promise<void> {
  const runConfig = loadRunConfig(path.join(repoRoot, "config", "run.config.json"));
  const profile: ClientProfile | undefined = cliArgs.clientName ? loadClientProfile(repoRoot, cliArgs.clientName) : undefined;
  const policy = new PolicyEngine(path.join(repoRoot, "config", "policy.json5"), profile?.policyPath);
  const store = new SkillStore(skillsDirFor(repoRoot, profile?.name), profile?.name);

  await ensureChrome(runConfig.browser.cdpEndpoint);
  mkdirSync(path.join(repoRoot, "runs"), { recursive: true });
  mkdirSync(path.join(repoRoot, "workspace"), { recursive: true });

  let healer: Healer | undefined;
  let healModel = "(no heal)";
  if (!cliArgs.noHeal) {
    try {
      const model = runConfig.models?.heal ?? runConfig.model;
      const { client, effectiveModel } = createLlmClient(model);
      healer = llmHealer(client, effectiveModel);
      healModel = model;
    } catch (err) {
      console.warn(`(self-heal unavailable: ${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const rows: Array<Record<string, string>> = cliArgs.csvPath
    ? parseCsv(cliArgs.csvPath).map((row) => ({ ...cliArgs.params, ...row }))
    : [cliArgs.params];

  const logger = new RunLogger(path.join(repoRoot, "runs"), {
    task: `replay ${cliArgs.skillName}${cliArgs.csvPath ? ` --csv ${cliArgs.csvPath} (${rows.length} rows)` : ` ${JSON.stringify(cliArgs.params)}`}`,
    client: profile?.name,
    model: `replay (heal: ${healModel})`,
    maxTurns: 0,
    maxCostUsd: 0,
    pricing: runConfig.pricing,
    policySnapshot: policy.snapshot,
    policySourcePath: policy.sourcePath,
  });
  console.log(`marionet replay ${logger.runId}`);
  console.log(`skill: ${cliArgs.skillName}${profile ? `  client: ${profile.name}` : ""}`);

  const mcp = await McpClientManager.connectAll(
    runConfig.mcpServers,
    repoRoot,
    runConfig.browser.cdpEndpoint,
    filterEnvForClient(process.env, profile),
  );

  let failures = 0;
  try {
    for (const [i, params] of rows.entries()) {
      if (rows.length > 1) console.log(`\n--- row ${i + 1}/${rows.length}: ${JSON.stringify(params)}`);
      const r = await replaySkill(cliArgs.skillName, params, { store, mcp, policy, logger, healer });
      if (r.status !== "success") failures++;
      console.log(`${r.status === "success" ? "ok " : "FAIL"} ${r.summary}`);
    }
  } finally {
    const status = failures === 0 ? "success" : "failure";
    logger.finalize(status);
    if (rows.length > 1) console.log(`\n${rows.length - failures}/${rows.length} rows succeeded`);
    console.log(`log: ${logger.runDir}`);
    await mcp.closeAll();
    process.exit(failures === 0 ? 0 : 1);
  }
}

function skillsCommand(repoRoot: string, clientName: string | undefined): void {
  const store = new SkillStore(skillsDirFor(repoRoot, clientName), clientName);
  const skills = store.list();
  if (!skills.length) {
    console.log(`No skills in ${store.skillsDir}. Compile a successful run first: marionet compile [run-id]`);
    return;
  }
  for (const s of skills) {
    const kind = isFlowSkill(s) ? "flow     " : "primitive";
    const params = s.params.map((p) => `${p.name}=${p.example}`).join(", ");
    console.log(`${kind}  ${s.name}(${params})`);
    console.log(`           ${s.description}`);
    if (isFlowSkill(s)) console.log(`           calls: ${s.calls.map((c) => c.skill).join(" -> ")}`);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const repoRoot = process.cwd();

  if (command === "last") {
    lastCommand(repoRoot, rest[0]);
    return;
  }

  if (command === "transcript") {
    transcriptCommand(repoRoot, rest[0]);
    return;
  }

  if (command === "compile") {
    const useHeuristic = rest.includes("--heuristic");
    const runId = rest.find((a) => a !== "--heuristic");
    await compileCommand(repoRoot, runId, useHeuristic);
    return;
  }

  if (command === "replay") {
    await replayCommand(repoRoot, parseReplayArgs(rest));
    return;
  }

  if (command === "skills") {
    const clientIdx = rest.indexOf("--client");
    skillsCommand(repoRoot, clientIdx >= 0 ? rest[clientIdx + 1] : undefined);
    return;
  }

  if (command !== "run") {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  let clientName: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--client") {
      clientName = rest[++i];
      if (!clientName) {
        console.error("--client requires a name");
        process.exitCode = 1;
        return;
      }
    } else {
      positional.push(rest[i]!);
    }
  }

  const task = positional.join(" ").trim();
  if (!task) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  await runCommand(repoRoot, task, clientName);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
