import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { McpServerConfig } from "./server-registry.js";

export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

/**
 * One MCP Client per configured server, spawned over stdio. Tool names are
 * already namespaced ("shell__exec", "browser__navigate", ...) by the server
 * itself at registration time, so routing is a flat lookup -- no additional
 * prefixing happens here.
 */
export class McpClientManager {
  private readonly clients: Client[] = [];
  private readonly toolOwner = new Map<string, Client>();
  readonly anthropicTools: Anthropic.Tool[] = [];

  static async connectAll(servers: McpServerConfig[], cwd: string, browserCdpEndpoint: string): Promise<McpClientManager> {
    const manager = new McpClientManager();
    for (const serverConfig of servers) {
      const transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args,
        cwd,
        env: { ...process.env, ...getDefaultEnvironment(), MARIONET_BROWSER_CDP_ENDPOINT: browserCdpEndpoint },
      });
      const client = new Client({ name: "marionet-orchestrator", version: "0.1.0" });
      await client.connect(transport);
      manager.clients.push(client);

      const { tools } = await client.listTools();
      for (const tool of tools) {
        manager.toolOwner.set(tool.name, client);
        manager.anthropicTools.push({
          name: tool.name,
          description: tool.description ?? "",
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        });
      }
    }
    return manager;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const client = this.toolOwner.get(name);
    if (!client) throw new Error(`No connected MCP server owns tool "${name}"`);
    const result = await client.callTool({ name, arguments: args });
    return result as unknown as McpToolResult;
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close()));
  }
}
