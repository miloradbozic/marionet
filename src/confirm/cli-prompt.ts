import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { PolicyRule } from "../policy/policy.types.js";

export type ConfirmResult = { approved: true } | { approved: false; note?: string };

// In-memory only, scoped to this run -- never written back to policy.json5,
// so an "always allow" choice doesn't silently change future runs' defaults.
const alwaysAllowed = new Set<string>();

function ruleKey(toolName: string, matchedRule: PolicyRule): string {
  return `${toolName}::${JSON.stringify(matchedRule)}`;
}

export async function confirmToolCall(
  toolName: string,
  args: unknown,
  matchedRule: PolicyRule,
  reasoningText: string | undefined,
): Promise<ConfirmResult> {
  const key = ruleKey(toolName, matchedRule);
  if (alwaysAllowed.has(key)) return { approved: true };

  console.log("\n--- marionet: confirmation required ---");
  console.log(`tool:  ${toolName}`);
  console.log(`args:  ${JSON.stringify(args, null, 2)}`);
  console.log(`rule:  ${JSON.stringify(matchedRule)}`);
  if (reasoningText) console.log(`model reasoning: ${reasoningText}`);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = (await rl.question("Allow this? [y]es / [n]o / [a]lways-allow-for-this-run: ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") return { approved: true };
      if (answer === "a" || answer === "always") {
        alwaysAllowed.add(key);
        return { approved: true };
      }
      if (answer === "n" || answer === "no") {
        const note = await rl.question("Optional note for the agent (why denied), or press enter to skip: ");
        return { approved: false, note: note.trim() || undefined };
      }
      console.log('Please answer "y", "n", or "a".');
    }
  } finally {
    rl.close();
  }
}
