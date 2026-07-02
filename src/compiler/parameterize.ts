import type { SkillPostCondition, SkillStep } from "./skill.types.js";

/**
 * Finds the run-specific literal values that should become parameters: tokens
 * from the task that also appear inside the executed step args. We deliberately
 * only treat *value-like* tokens as candidates -- quoted strings, or tokens
 * containing a digit (SKUs, EANs, IDs, versions). Pure prose words like "EAN"
 * or "Akeneo" are excluded: they show up in attribute-search values but not in
 * the matching CSS selectors (which are lowercased/snake_cased), so
 * parameterizing them would produce an inconsistent, half-substituted skill.
 *
 * Note: match against args only (not recorded result texts) -- a task token
 * that appears only in what the page *said* was never an input, so it is not
 * a parameter.
 */
export function detectLiterals(task: string, steps: SkillStep[], postCondition: SkillPostCondition): string[] {
  const argHaystack = JSON.stringify([steps.map((s) => s.args), postCondition]);

  const candidates = new Set<string>();
  for (const m of task.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const v = m[1] ?? m[2];
    if (v) candidates.add(v);
  }
  for (const m of task.matchAll(/[A-Za-z0-9._-]{3,}/g)) {
    const tok = m[0];
    if (/\d/.test(tok)) candidates.add(tok);
  }

  // Keep only candidates that actually appear in the args, longest first so a
  // longer literal is substituted before any shorter token nested inside it.
  return [...candidates]
    .filter((c) => argHaystack.includes(c))
    .sort((a, b) => b.length - a.length);
}

export interface ParamMapping {
  literal: string;
  name: string;
}

/** Longest-literal-first mapping, so nested tokens can't shadow longer ones. */
export function buildMapping(paramNames: Record<string, string>): ParamMapping[] {
  return Object.entries(paramNames)
    .map(([literal, name]) => ({ literal, name }))
    .sort((a, b) => b.literal.length - a.literal.length);
}

function substituteInValue(value: unknown, literal: string, placeholder: string): unknown {
  if (typeof value === "string") return value.split(literal).join(placeholder);
  if (Array.isArray(value)) return value.map((v) => substituteInValue(v, literal, placeholder));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substituteInValue(v, literal, placeholder)]),
    );
  }
  return value;
}

function substituteString(s: string, mapping: ParamMapping[]): string {
  return mapping.reduce((acc, { literal, name }) => acc.split(literal).join(`{{${name}}}`), s);
}

function substituteArgs(args: Record<string, unknown>, mapping: ParamMapping[]): Record<string, unknown> {
  let out = args;
  for (const { literal, name } of mapping) {
    out = substituteInValue(out, literal, `{{${name}}}`) as Record<string, unknown>;
  }
  return out;
}

/**
 * Returns a clean SkillStep (recorded result text, if any, does not survive
 * into the skill file) with every literal occurrence replaced by its
 * {{name}} placeholder -- in args and in the semantic locator's accessible
 * name (a row's name contains the SKU it was matched by, for example).
 */
export function parameterizeStep(step: SkillStep, mapping: ParamMapping[]): SkillStep {
  return {
    tool: step.tool,
    args: substituteArgs(step.args, mapping),
    ...(step.locator ? { locator: { role: step.locator.role, name: substituteString(step.locator.name, mapping) } } : {}),
    ...(step.waitFor ? { waitFor: step.waitFor } : {}),
  };
}

export function parameterizePostCondition(post: SkillPostCondition, mapping: ParamMapping[]): SkillPostCondition {
  return {
    tool: post.tool,
    args: substituteArgs(post.args, mapping),
    expectPattern: substituteString(post.expectPattern, mapping),
  };
}
