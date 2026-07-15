import type { SemanticLocator } from "./skill.types.js";

/**
 * Anchor stability scoring (REINVENTION P3).
 *
 * A compiled skill anchors its steps on an element's semantic identity (role +
 * accessible name). Not all identities are equally durable, and the compiler
 * had no opinion about that -- it recorded whatever the run happened to touch.
 * So a skill could be born anchored to something guaranteed to rot, and
 * nothing said a word until a replay failed months later.
 *
 * Scoring is grounded in how the names are actually produced
 * (`mcp-servers/browser/src/identity.ts`, `nameOf`), not in taste:
 *
 *  - `nameOf` prefers an AUTHORED label -- aria-label, aria-labelledby,
 *    <label>, placeholder, title. Those are written by a developer and change
 *    only when the UI's meaning changes. That is the good case.
 *  - Its LAST resort is `textContent`, truncated to 80 chars with a literal
 *    "..." appended. So a name ending in "..." is proof the anchor is a
 *    container's concatenated descendant text with its tail cut off -- not a
 *    label at all.
 *  - `roleOf` maps <tr> to "row". A container role has no label of its own, so
 *    its name is always descendant text: whatever the row happens to contain
 *    today, in whatever order it renders.
 *
 * The failure this catches is subtler than the CSS churn P1 warns about. A
 * class name rots when someone redeploys. An anchor carrying a completeness
 * percentage or an "updated" timestamp rots *because you used the record* --
 * no deploy required. P1 would pass such an anchor: it mentions no class.
 */

export type StabilityScore = "stable" | "weak" | "fragile";

const SEVERITY: Record<StabilityScore, number> = { stable: 0, weak: 1, fragile: 2 };

export interface StabilityVerdict {
  score: StabilityScore;
  /** Human-readable, one clause per signal; empty when stable. */
  reasons: string[];
}

/**
 * Roles whose accessible name can only come from descendant text, because the
 * element is a container rather than a labelled control. Mirrors the roles
 * `identity.ts` emits (<tr> -> "row", unknown -> "generic") plus the common
 * explicit container roles a `role=` attribute can set.
 */
const CONTAINER_ROLES = new Set(["row", "generic", "cell", "gridcell", "listitem", "group", "region", "table", "rowgroup", "list"]);

/** identity.ts truncates textContent-derived names at 80 chars and appends this. */
const TRUNCATION_MARKER = /\.\.\.$|…$/;

/** {{param}} placeholders are intentional; mask them before hunting for volatile literals. */
const PARAM_RE = /\{\{[a-z][a-z0-9_]*\}\}/gi;

/**
 * Content that changes on its own schedule, with no redesign involved. An
 * anchor containing any of these is dated the moment it is compiled.
 */
const VOLATILE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\d+\s*%/, why: "contains a percentage (progress/completeness values change when the record is edited)" },
  { re: /\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/, why: "contains a date (an 'updated' timestamp changes on every save)" },
  { re: /\d{1,2}:\d{2}/, why: "contains a time of day" },
  { re: /\b\d[\d\s,.]{4,}\b/, why: "contains a long digit run that was not parameterized (a run-specific id or count?)" },
];

/** Beyond this, a name is a sentence or a concatenation rather than a label. */
const LONG_NAME_CHARS = 40;

/**
 * Scores one anchor. Absent-name anchors never reach here: `targetSuffix`
 * emits nothing without a name, so an unnamed element is never recorded as a
 * locator in the first place.
 */
export function scoreLocator(locator: SemanticLocator): StabilityVerdict {
  const { role, name } = locator;
  const reasons: string[] = [];
  let score: StabilityScore = "stable";

  // Every signal is independent evidence; the verdict is the worst of them.
  const demote = (to: StabilityScore, why: string) => {
    reasons.push(why);
    if (SEVERITY[to] > SEVERITY[score]) score = to;
  };

  // Params are the compiler doing its job; the junk around them still counts.
  const literal = name.replace(PARAM_RE, "");
  const isContainer = CONTAINER_ROLES.has(role);

  if (TRUNCATION_MARKER.test(name)) {
    demote(
      "fragile",
      'name is truncated ("..."), so it is a container\'s concatenated text with its tail cut off -- not a label',
    );
  }

  for (const { re, why } of VOLATILE_PATTERNS) {
    if (re.test(literal)) demote("fragile", why);
  }

  if (isContainer && name.length > LONG_NAME_CHARS) {
    demote("fragile", `role "${role}" is a container, so its name is whatever its descendants render today`);
  } else if (isContainer) {
    demote("weak", `role "${role}" is a container: its name comes from descendant text, not an authored label`);
  } else if (name.length > LONG_NAME_CHARS) {
    demote("weak", `name is ${name.length} chars -- long enough to be visible text rather than an authored label`);
  }

  return { score, reasons };
}

/** True when an anchor should not be trusted as a primary target. */
export function isFragile(locator: SemanticLocator | undefined): boolean {
  return Boolean(locator && scoreLocator(locator).score === "fragile");
}

/** `role "name"`, truncated for one-line reports. */
export function describeLocator(locator: SemanticLocator, max = 60): string {
  const name = locator.name.length > max ? `${locator.name.slice(0, max - 3)}...` : locator.name;
  return `${locator.role} ${JSON.stringify(name)}`;
}
