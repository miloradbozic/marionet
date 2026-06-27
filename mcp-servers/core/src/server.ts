import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

// Tool names are pre-namespaced ("shell__", "fs__") at registration time so the
// orchestrator's policy engine can match on the exact string MCP reports back,
// with no extra prefixing step in between.
const WORKSPACE_ROOT = path.resolve(process.cwd(), "workspace");

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(WORKSPACE_ROOT, p);
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const server = new McpServer({ name: "marionet-core", version: "0.1.0" });

server.registerTool(
  "shell__exec",
  {
    description:
      "Execute a shell command (bash). Runs unattended unless it matches the policy denylist (e.g. disk-destroying commands, git push).",
    inputSchema: {
      command: z.string().describe("The shell command to run"),
      cwd: z.string().optional().describe("Working directory; relative paths resolve against workspace/"),
      timeoutMs: z.number().int().positive().max(600_000).optional().describe("Default 120000ms"),
    },
  },
  async ({ command, cwd, timeoutMs }): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }> => {
    const resolvedCwd = cwd ? resolvePath(cwd) : WORKSPACE_ROOT;
    await fs.mkdir(resolvedCwd, { recursive: true });
    return new Promise((resolve) => {
      exec(
        command,
        { cwd: resolvedCwd, timeout: timeoutMs ?? 120_000, maxBuffer: 10 * 1024 * 1024, shell: "/bin/bash" },
        (error, stdout, stderr) => {
          const exitCode = error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? (error as unknown as { code: number }).code : 1) : 0;
          const text = [
            `exit code: ${exitCode}`,
            stdout ? `--- stdout ---\n${stdout}` : "",
            stderr ? `--- stderr ---\n${stderr}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          resolve({ content: [{ type: "text", text }], isError: Boolean(error) });
        },
      );
    });
  },
);

server.registerTool(
  "fs__read",
  {
    description: "Read a UTF-8 text file. Relative paths resolve against workspace/.",
    inputSchema: { path: z.string() },
  },
  async ({ path: p }) => {
    try {
      const content = await fs.readFile(resolvePath(p), "utf-8");
      return { content: [{ type: "text" as const, text: content }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "fs__write",
  {
    description: "Write a UTF-8 text file, creating parent directories as needed. Relative paths resolve against workspace/.",
    inputSchema: { path: z.string(), content: z.string() },
  },
  async ({ path: p, content }) => {
    try {
      const resolved = resolvePath(p);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf-8");
      return { content: [{ type: "text" as const, text: `Wrote ${content.length} bytes to ${resolved}` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "fs__list",
  {
    description: "List directory entries. Relative paths resolve against workspace/; defaults to workspace/ root.",
    inputSchema: { path: z.string().optional() },
  },
  async ({ path: p }) => {
    try {
      const resolved = p ? resolvePath(p) : WORKSPACE_ROOT;
      await fs.mkdir(resolved, { recursive: true });
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const text = entries.length
        ? entries.map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`).join("\n")
        : "(empty directory)";
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
