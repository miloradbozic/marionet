import { readFileSync } from "node:fs";

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
}

export interface RunConfig {
  model: string;
  maxTokens: number;
  maxTurns: number;
  maxCostUsd: number;
  pricing?: { input: number; output: number };
  supportsVision?: boolean;
  browser: { cdpEndpoint: string };
  mcpServers: McpServerConfig[];
}

export function loadRunConfig(configPath: string): RunConfig {
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as RunConfig;
  // estimateCostUsd returns 0 without pricing, which would silently disable
  // the cost ceiling. Fail at startup instead of pretending to enforce it.
  if (config.maxCostUsd > 0 && !config.pricing) {
    throw new Error(
      `run.config.json sets maxCostUsd=${config.maxCostUsd} but has no "pricing" ({ input, output } USD per million tokens). ` +
        "Cost tracking would be silently disabled. Add pricing, or set maxCostUsd to 0 to run without a ceiling.",
    );
  }
  return config;
}
