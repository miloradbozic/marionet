import type { McpContentBlock, McpToolResult } from "../mcp/mcp-client-manager.js";

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * Converts an MCP tool result to content for an OpenAI tool message.
 * Text-only results become a plain string.
 * Results with images become a content-part array (cast as string — the API accepts it,
 * the SDK types just don't reflect it for tool messages).
 * When supportsVision is false, image blocks are replaced with a text note.
 */
export function mcpResultToToolContent(result: McpToolResult, supportsVision = true): string {
  const parts: Array<
    { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
  > = [];

  for (const block of result.content) {
    if (block.type === "image" && block.data && block.mimeType && ALLOWED_IMAGE_MIME_TYPES.has(block.mimeType)) {
      if (supportsVision) {
        parts.push({ type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
      } else {
        parts.push({ type: "text", text: "[screenshot taken but image output is not supported by this model]" });
      }
    } else {
      parts.push({ type: "text", text: block.text ?? JSON.stringify(block) });
    }
  }

  if (parts.every((p) => p.type === "text")) {
    return parts.map((p) => (p as { type: "text"; text: string }).text).join("\n");
  }

  // Mixed content (includes images): cast to string — the actual API accepts content part arrays
  // on tool messages even though the SDK types only declare string.
  return parts as unknown as string;
}
