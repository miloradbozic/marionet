import { readFileSync } from "node:fs";
import JSON5 from "json5";
import type { PolicyConfig, PolicyDecision, PolicyRule } from "./policy.types.js";

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

const FAIL_CLOSED_RULE: PolicyRule = { match: "*", action: "deny" };

/**
 * Loads config/policy.json5 once at construction time and snapshots it, so a
 * run's gating decisions stay explicable later even if the file is edited
 * mid-run or afterward (see logging design: meta.json stores this snapshot).
 *
 * An optional client policy (clients/<name>/policy.json5) is evaluated
 * BEFORE the global rules -- first-match-wins, so a client profile can
 * tighten or loosen specific tools for that client only. The snapshot
 * contains the merged rule list actually used for the run.
 */
export class PolicyEngine {
  private readonly rules: PolicyRule[];
  readonly sourcePath: string;
  readonly snapshot: PolicyConfig;

  constructor(policyFilePath: string, clientPolicyPath?: string) {
    this.sourcePath = clientPolicyPath ? `${clientPolicyPath} + ${policyFilePath}` : policyFilePath;
    const globalConfig = JSON5.parse(readFileSync(policyFilePath, "utf-8")) as PolicyConfig;
    const clientRules = clientPolicyPath
      ? (JSON5.parse(readFileSync(clientPolicyPath, "utf-8")) as PolicyConfig).rules
      : [];
    this.snapshot = { rules: [...clientRules, ...globalConfig.rules] };
    this.rules = this.snapshot.rules;
  }

  evaluate(toolName: string, args: Record<string, unknown>): PolicyDecision {
    for (const rule of this.rules) {
      if (!globToRegExp(rule.match).test(toolName)) continue;
      if (rule.when?.argsMatch) {
        const allFieldsMatch = Object.entries(rule.when.argsMatch).every(([field, pattern]) => {
          const value = args[field];
          if (value === undefined) return false;
          return new RegExp(pattern).test(String(value));
        });
        if (!allFieldsMatch) continue;
      }
      return { action: rule.action, matchedRule: rule };
    }
    // Unreachable if the policy file ends in a "*" catch-all, but fail closed regardless.
    return { action: "deny", matchedRule: FAIL_CLOSED_RULE };
  }
}
