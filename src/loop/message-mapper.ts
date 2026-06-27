import type Anthropic from "@anthropic-ai/sdk";
import type { McpContentBlock, McpToolResult } from "../mcp/mcp-client-manager.js";

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Translates an MCP tool result into the content shape a tool_result block expects. */
export function mcpResultToToolResultContent(
  result: McpToolResult,
): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  return result.content.map((block: McpContentBlock) => {
    if (block.type === "image" && block.data && block.mimeType && ALLOWED_IMAGE_MIME_TYPES.has(block.mimeType)) {
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: block.data,
        },
      };
    }
    return { type: "text" as const, text: block.text ?? JSON.stringify(block) };
  });
}
