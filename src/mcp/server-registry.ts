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
  browser: { cdpEndpoint: string };
  mcpServers: McpServerConfig[];
}

export function loadRunConfig(configPath: string): RunConfig {
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as RunConfig;
}
