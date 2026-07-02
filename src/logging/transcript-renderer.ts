import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface ContentBlockLike {
  type: string;
  text?: string;
}

function summarizeContent(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((block) => {
      if (block && typeof block === "object" && "type" in block) {
        const b = block as ContentBlockLike;
        return b.type === "text" ? (b.text ?? "").slice(0, 500) : `[${b.type}]`;
      }
      return JSON.stringify(block);
    })
    .join(" ");
}

/** Convenience render of events.jsonl for fast human skim. Never the source of truth. */
export function renderTranscript(runDir: string): string {
  const eventsRaw = readFileSync(path.join(runDir, "events.jsonl"), "utf-8");
  const lines = eventsRaw.split("\n").filter(Boolean);
  const parts: string[] = [];
  let lastIter = -1;

  for (const line of lines) {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.iter !== lastIter) {
      parts.push(`\n### Turn ${event.iter as number}\n`);
      lastIter = event.iter as number;
    }
    switch (event.type) {
      case "model_response": {
        if (event.text) parts.push(`**Model:** ${event.text as string}\n`);
        for (const tu of (event.toolUses as Array<{ name: string; input: unknown }>) ?? []) {
          parts.push(`- called \`${tu.name}\` with \`${JSON.stringify(tu.input)}\``);
        }
        break;
      }
      case "policy_decision":
        parts.push(`  - policy: \`${event.tool}\` -> **${event.action}**`);
        break;
      case "human_decision":
        parts.push(`  - human: **${event.decision}**${event.note ? ` ("${event.note}")` : ""}`);
        break;
      case "tool_result":
        parts.push(`  - result${event.isError ? " (error)" : ""}: ${summarizeContent(event.content)}`);
        break;
      case "verification":
        parts.push(
          `  - verification: \`${event.tool}\` vs /${event.expectPattern}/ -> **${event.matched ? "matched" : "failed"}**`,
        );
        break;
      case "finish_rejected":
        parts.push(`  - finish_task **rejected**: ${(event.reason as string).slice(0, 300)}`);
        break;
      case "llm_retry":
        parts.push(`  - (llm retry ${event.attempt}: ${event.error as string})`);
        break;
      case "finish_task":
        parts.push(`\n### Finished: ${event.status as string}\n${event.summary as string}`);
        break;
      case "run_halted":
        parts.push(`\n### Halted: ${event.reason as string}`);
        break;
      case "nudge":
        parts.push(`  - (nudge: model produced no tool call)`);
        break;
      default:
        break;
    }
  }

  const markdown = parts.join("\n").trim() + "\n";
  writeFileSync(path.join(runDir, "transcript.md"), markdown);
  return markdown;
}
