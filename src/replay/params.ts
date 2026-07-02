/**
 * Runtime parameter substitution for skill replay. The compiler stores
 * {{param}} placeholders; replay resolves them against the values supplied on
 * the command line (or by a parent flow). Fail-closed: an unresolved
 * placeholder aborts the replay instead of sending a literal "{{sku}}" to a
 * client system.
 */

const PLACEHOLDER = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

export class ParamError extends Error {}

export function substituteString(template: string, params: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new ParamError(`missing value for parameter "${name}"`);
    return value;
  });
}

export function substituteDeep(value: unknown, params: Record<string, string>): unknown {
  if (typeof value === "string") return substituteString(value, params);
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, params));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substituteDeep(v, params)]),
    );
  }
  return value;
}

export function substituteArgs(args: Record<string, unknown>, params: Record<string, string>): Record<string, unknown> {
  return substituteDeep(args, params) as Record<string, unknown>;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * expectPattern is a regex, so parameter values substituted into it must be
 * escaped: an EAN is digits today, but a value like "a.b(c)" would otherwise
 * change the pattern's meaning (the reviewer's "regex metacharacters" note).
 */
export function substitutePattern(pattern: string, params: Record<string, string>): string {
  return pattern.replace(PLACEHOLDER, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new ParamError(`missing value for parameter "${name}"`);
    return escapeRegex(value);
  });
}
