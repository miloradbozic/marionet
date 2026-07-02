import type { SkillPostCondition, SkillStep } from "./skill.types.js";

/**
 * Finds the run-specific literal values that should become parameters: tokens
 * from the task that also appear inside the executed step args. We deliberately
 * only treat *value-like* tokens as candidates -- quoted strings, or tokens
 * containing a digit (SKUs, EANs, IDs, versions). Pure prose words like "EAN"
 * or "Akeneo" are excluded: they show up in attribute-search values but not in
 * the matching CSS selectors (which are lowercased/snake_cased), so
 * parameterizing them would produce an inconsistent, half-substituted skill.
 */
export function detectLiterals(task: string, steps: SkillStep[], postCondition: SkillPostCondition): string[] {
  const argHaystack = JSON.stringify([steps, postCondition]);

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

function substituteArgs(
  args: Record<string, unknown>,
  mapping: Array<{ literal: string; name: string }>,
): Record<string, unknown> {
  let out = args;
  for (const { literal, name } of mapping) {
    out = substituteInValue(out, literal, `{{${name}}}`) as Record<string, unknown>;
  }
  return out;
}

export interface ParameterizeResult {
  steps: SkillStep[];
  postCondition: SkillPostCondition;
}

/**
 * Replaces every occurrence of each literal in the step/post-condition args
 * with its `{{name}}` placeholder. `paramNames` maps literal value -> param
 * name (supplied by the namer).
 */
export function parameterize(
  steps: SkillStep[],
  postCondition: SkillPostCondition,
  paramNames: Record<string, string>,
): ParameterizeResult {
  const mapping = Object.entries(paramNames)
    .map(([literal, name]) => ({ literal, name }))
    .sort((a, b) => b.literal.length - a.literal.length);

  return {
    steps: steps.map((s) => ({ tool: s.tool, args: substituteArgs(s.args, mapping) })),
    postCondition: {
      tool: postCondition.tool,
      args: substituteArgs(postCondition.args, mapping),
      expectPattern: mapping.reduce(
        (pat, { literal, name }) => pat.split(literal).join(`{{${name}}}`),
        postCondition.expectPattern,
      ),
    },
  };
}
