import type { OpenAI } from "openai";
import { withLlmRetry } from "../llm-client.js";
import { CompileError, type TraceStep } from "./trajectory.js";
import type { SkillPostCondition } from "./skill.types.js";

/**
 * Segmentation: split one recorded trajectory into independently-replayable
 * primitive skills ("skills, not recordings"). One LLM call proposes the
 * boundaries, names, per-segment post-conditions, param names, and playbook
 * notes; strict code-side validation decides whether to trust it. Anything
 * invalid falls back to a single monolithic segment -- a worse library entry,
 * never a wrong one.
 */

export interface SegmentSpec {
  /** snake_case verb_noun, e.g. "open_product_by_sku". */
  name: string;
  description: string;
  /** Inclusive step-index range into the extracted trajectory. */
  firstStep: number;
  lastStep: number;
  /**
   * Read-only check that the segment reached its goal. Required for every
   * segment except the last (which inherits the run's verified post-condition).
   * Must hold for ANY parameter values -- no run-specific IDs.
   */
  postCondition?: SkillPostCondition;
}

export interface Segmentation {
  /** Name for the composed flow skill, e.g. "set_ean_for_product". */
  flowName: string;
  flowDescription: string;
  /** Maps detected literal value -> snake_case param name. */
  paramNames: Record<string, string>;
  segments: SegmentSpec[];
  /** System quirks worth recording in the client playbook. */
  playbookNotes: string[];
}

export interface SegmenterInput {
  task: string;
  steps: TraceStep[];
  /** The detected literal values that will become parameters. */
  literals: string[];
}

export type Segmenter = (input: SegmenterInput) => Promise<Segmentation>;

/**
 * Post-condition tools must be read-only: a post-condition that mutates the
 * page would make "check the skill worked" itself an action. Fail-closed
 * allowlist, mirroring the policy engine's philosophy.
 */
const READONLY_POSTCONDITION_TOOLS = new Set(["browser__eval", "browser__extract", "browser__wait_for", "fs__read"]);

/**
 * Offline fallback: the whole trajectory as one segment, named from the task,
 * params named positionally. Deterministic; used with --heuristic and whenever
 * the LLM segmentation fails validation.
 */
export const monolithSegmenter: Segmenter = async ({ task, steps, literals }) => {
  const slug =
    task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .split("_")
      .filter((w) => !/\d/.test(w)) // literals make terrible names
      .slice(0, 6)
      .join("_") || "skill";
  const paramNames: Record<string, string> = {};
  literals.forEach((lit, i) => {
    paramNames[lit] = `param${i + 1}`;
  });
  return {
    flowName: slug,
    flowDescription: task,
    paramNames,
    segments: [{ name: slug, description: task, firstStep: 0, lastStep: steps.length - 1 }],
    playbookNotes: [],
  };
};

/**
 * Throws CompileError unless the segmentation is safe to compile:
 * - segments form a contiguous, in-order partition of all steps
 * - names are unique snake_case
 * - every paramNames key is a detected literal (the namer/segmenter must not
 *   invent substitution targets -- see the compile-time trust boundary)
 * - every non-final segment has a read-only post-condition
 */
export function validateSegmentation(seg: Segmentation, stepCount: number, literals: string[]): void {
  if (!seg.segments.length) throw new CompileError("segmentation has no segments");
  const nameRe = /^[a-z][a-z0-9_]*$/;
  if (!nameRe.test(seg.flowName)) throw new CompileError(`flow name "${seg.flowName}" is not snake_case`);

  let expected = 0;
  const names = new Set<string>();
  for (const [i, s] of seg.segments.entries()) {
    if (!nameRe.test(s.name)) throw new CompileError(`segment name "${s.name}" is not snake_case`);
    if (names.has(s.name)) throw new CompileError(`duplicate segment name "${s.name}"`);
    names.add(s.name);
    if (s.firstStep !== expected) {
      throw new CompileError(`segments must partition steps contiguously: segment ${i} starts at ${s.firstStep}, expected ${expected}`);
    }
    if (s.lastStep < s.firstStep || s.lastStep >= stepCount) {
      throw new CompileError(`segment ${i} has invalid range [${s.firstStep}, ${s.lastStep}] for ${stepCount} steps`);
    }
    expected = s.lastStep + 1;

    const isLast = i === seg.segments.length - 1;
    if (!isLast) {
      if (!s.postCondition) throw new CompileError(`non-final segment "${s.name}" has no post-condition`);
      if (!READONLY_POSTCONDITION_TOOLS.has(s.postCondition.tool)) {
        throw new CompileError(`segment "${s.name}" post-condition tool "${s.postCondition.tool}" is not a read-only tool`);
      }
      if (typeof s.postCondition.expectPattern !== "string" || !s.postCondition.expectPattern) {
        throw new CompileError(`segment "${s.name}" post-condition has no expectPattern`);
      }
    }
  }
  if (expected !== stepCount) {
    throw new CompileError(`segments cover ${expected} of ${stepCount} steps`);
  }

  const literalSet = new Set(literals);
  for (const key of Object.keys(seg.paramNames)) {
    if (!literalSet.has(key)) {
      throw new CompileError(`paramNames key "${key}" is not a detected literal`);
    }
  }
}

const SEGMENTER_SYSTEM = `You segment one successful browser-automation run into reusable, independently-replayable "skills".
Input JSON: { task, steps: [{ index, tool, args, result }], literals }.
Return STRICT JSON only (no prose, no markdown fences):
{
  "flowName": "snake_case_verb_noun",
  "flowDescription": "one sentence",
  "paramNames": { "<literal>": "snake_case_param" },
  "segments": [
    { "name": "snake_case_verb_noun", "description": "one sentence",
      "firstStep": 0, "lastStep": 4,
      "postCondition": { "tool": "browser__eval", "args": { "expression": "..." }, "expectPattern": "regex" } }
  ],
  "playbookNotes": ["short quirk observed about this system", ...]
}
Rules:
- Segments must partition steps contiguously in order (firstStep..lastStep inclusive), no gaps, no overlaps.
- Split at natural sub-goal boundaries a future task could reuse independently (e.g. "open a record by id" vs "edit a field and save"). Navigation to a new page/entity usually starts a new segment. 2-4 segments is typical; use 1 only if the run truly has a single goal.
- Every segment EXCEPT the last needs a postCondition: a read-only check (tool must be browser__eval, browser__extract, browser__wait_for, or fs__read) proving the segment reached its goal. It MUST hold for any parameter values: never reference run-specific values like record UUIDs from the results; prefer structural checks (an element that only exists on the target page, location.hash shape, etc). The last segment's postCondition is ignored (the run's own verification is used).
- Every literal in the input MUST get a paramNames entry; choose meaningful snake_case names from how the value is used (an id the task acts on -> its noun like "sku"; a value being written -> the field name like "ean").
- playbookNotes: 0-4 short, durable quirks of the system a future operator/agent should know (e.g. "product grid search fires only on Enter, not on input"). No run-specific values. Empty array if nothing notable.`;

/** LLM-backed segmenter: one call that proposes boundaries, names, and post-conditions. */
export function llmSegmenter(client: OpenAI, model: string): Segmenter {
  return async ({ task, steps, literals }) => {
    const user = JSON.stringify({
      task,
      steps: steps.map((s, index) => ({ index, tool: s.tool, args: s.args, result: s.resultText })),
      literals,
    });
    const res = await withLlmRetry(() =>
      client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SEGMENTER_SYSTEM },
          { role: "user", content: user },
        ],
      }),
    );
    const text = res.choices[0]?.message?.content ?? "";
    return parseSegmentationJson(text);
  };
}

function parseSegmentationJson(text: string): Segmentation {
  const match = text.match(/\{[\s\S]*\}/);
  const raw = match ? match[0] : text;
  const obj = JSON.parse(raw) as Partial<Segmentation>;
  if (!obj.flowName || typeof obj.flowName !== "string") throw new CompileError("segmenter response missing flowName");
  if (!Array.isArray(obj.segments)) throw new CompileError("segmenter response missing segments");
  return {
    flowName: obj.flowName,
    flowDescription: obj.flowDescription ?? "",
    paramNames: obj.paramNames ?? {},
    segments: obj.segments,
    playbookNotes: Array.isArray(obj.playbookNotes) ? obj.playbookNotes.filter((n) => typeof n === "string") : [],
  };
}
