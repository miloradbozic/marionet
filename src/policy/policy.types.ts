export type PolicyAction = "allow" | "ask" | "deny";

export interface PolicyRule {
  /** Exact tool id ("shell__exec") or a glob ("gui__*", "*"). */
  match: string;
  when?: {
    /** field name -> regex source, tested against String(args[field]) */
    argsMatch?: Record<string, string>;
  };
  action: PolicyAction;
}

export interface PolicyConfig {
  rules: PolicyRule[];
}

export interface PolicyDecision {
  action: PolicyAction;
  matchedRule: PolicyRule;
}
