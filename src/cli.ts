import path from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { loadRunConfig } from "./mcp/server-registry.js";
import { McpClientManager } from "./mcp/mcp-client-manager.js";
import { PolicyEngine } from "./policy/policy-engine.js";
import { RunLogger } from "./logging/run-logger.js";
import { renderTranscript } from "./logging/transcript-renderer.js";
import { runAgentLoop } from "./loop/agent-loop.js";
import { createAnthropicClient } from "./anthropic-client.js";

const USAGE = 'Usage: marionet run "<task>"\n       marionet transcript [run-id]';

async function runCommand(repoRoot: string, task: string): Promise<void> {
  const runConfig = loadRunConfig(path.join(repoRoot, "config", "run.config.json"));
  const policy = new PolicyEngine(path.join(repoRoot, "config", "policy.json5"));

  mkdirSync(path.join(repoRoot, "runs"), { recursive: true });
  mkdirSync(path.join(repoRoot, "workspace"), { recursive: true });

  const logger = new RunLogger(path.join(repoRoot, "runs"), {
    task,
    model: runConfig.model,
    maxTurns: runConfig.maxTurns,
    maxCostUsd: runConfig.maxCostUsd,
    policySnapshot: policy.snapshot,
    policySourcePath: policy.sourcePath,
  });

  console.log(`marionet run ${logger.runId}`);
  console.log(`task: ${task}`);

  const mcpClientManager = await McpClientManager.connectAll(
    runConfig.mcpServers,
    repoRoot,
    runConfig.browser.cdpEndpoint,
  );

  let exitCode = 1;
  try {
    const result = await runAgentLoop({
      task,
      model: runConfig.model,
      maxTokens: runConfig.maxTokens,
      maxTurns: runConfig.maxTurns,
      maxCostUsd: runConfig.maxCostUsd,
      anthropicClient: createAnthropicClient(),
      mcpClientManager,
      policy,
      logger,
    });

    logger.finalize(result.status);
    renderTranscript(logger.runDir);

    console.log(`\nstatus: ${result.status}`);
    console.log(result.summary);
    if (result.details) console.log(result.details);
    console.log(`\nlog: ${logger.runDir}`);

    exitCode = result.status === "success" ? 0 : 1;
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

function transcriptCommand(repoRoot: string, runId: string | undefined): void {
  const runDir = resolveRunDir(repoRoot, runId);
  // Re-renders from events.jsonl even if the run never reached a clean
  // finalize (Ctrl-C, crash) -- that's the whole point of this command.
  const markdown = renderTranscript(runDir);
  console.log(markdown);
  console.error(`\n(rendered from ${path.join(runDir, "events.jsonl")})`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const repoRoot = process.cwd();

  if (command === "transcript") {
    transcriptCommand(repoRoot, rest[0]);
    return;
  }

  if (command !== "run" || !rest[0]) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  await runCommand(repoRoot, rest[0]);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
