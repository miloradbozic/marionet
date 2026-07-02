import { detectLiterals, buildMapping, parameterizeStep, parameterizePostCondition } from "./parameterize.js";
import { assertCompilable, extractTrajectory, type RunEvent } from "./trajectory.js";
import { monolithSegmenter, validateSegmentation, type Segmentation, type Segmenter } from "./segment.js";
import type { FlowSkill, Skill, SkillParam, SkillPostCondition, SkillSource, SkillStep } from "./skill.types.js";

export interface CompileInput {
  events: RunEvent[];
  runId: string;
  task: string;
  model: string;
  client?: string;
  metaStatus?: string;
  segmenter: Segmenter;
}

export interface CompileResult {
  /** One primitive skill per segment, in trajectory order. */
  primitives: Skill[];
  /** The composed flow chaining the primitives; null when there is only one segment. */
  flow: FlowSkill | null;
  /** System quirks the segmenter observed, for the client playbook. */
  playbookNotes: string[];
  /** Set when the LLM segmentation was rejected and the monolith fallback was used. */
  fallbackReason?: string;
}

/**
 * Compiles one run's events into parameterized, verifiable skills.
 *
 * The detected `literals` are the sole source of truth for what gets
 * substituted; the segmenter only supplies display names (its paramNames keys
 * are validated to be a subset of the literals). Building the mapping from
 * `literals` means an over-eager segmenter can't inject unintended
 * replacements into the args, and guarantees `params` and the substituted
 * steps stay consistent.
 *
 * A segmentation that fails validation is never "partially" trusted: the
 * whole proposal is discarded for the deterministic monolith. A worse library
 * entry, never a wrong one.
 */
export async function compileRun(input: CompileInput): Promise<CompileResult> {
  assertCompilable(input.events, input.metaStatus);
  const { steps, postCondition } = extractTrajectory(input.events);
  const literals = detectLiterals(input.task, steps, postCondition);

  let seg: Segmentation;
  let fallbackReason: string | undefined;
  try {
    seg = await input.segmenter({ task: input.task, steps, literals });
    validateSegmentation(seg, steps.length, literals);
  } catch (err) {
    fallbackReason = err instanceof Error ? err.message : String(err);
    seg = await monolithSegmenter({ task: input.task, steps, literals });
    validateSegmentation(seg, steps.length, literals); // monolith is deterministic; this is a self-check
  }

  const nameFor = (lit: string): string => seg.paramNames[lit] ?? `param${literals.indexOf(lit) + 1}`;
  const mapping = buildMapping(Object.fromEntries(literals.map((lit) => [lit, nameFor(lit)])));

  const substitutedSteps: SkillStep[] = steps.map((s) => parameterizeStep(s, mapping));
  const finalPost = parameterizePostCondition(postCondition, mapping);

  const source: SkillSource = {
    runId: input.runId,
    task: input.task,
    model: input.model,
    compiledAt: new Date().toISOString(),
  };

  const paramsUsedIn = (json: string): SkillParam[] =>
    literals.filter((lit) => json.includes(`{{${nameFor(lit)}}}`)).map((lit) => ({ name: nameFor(lit), example: lit }));

  const primitives: Skill[] = seg.segments.map((spec, i) => {
    const segSteps = substitutedSteps.slice(spec.firstStep, spec.lastStep + 1);
    const isLast = i === seg.segments.length - 1;
    const post: SkillPostCondition = isLast ? finalPost : parameterizePostCondition(spec.postCondition!, mapping);
    return {
      kind: "primitive" as const,
      name: spec.name,
      ...(input.client ? { client: input.client } : {}),
      description: spec.description,
      params: paramsUsedIn(JSON.stringify([segSteps, post])),
      steps: segSteps,
      postCondition: post,
      source,
    };
  });

  let flow: FlowSkill | null = null;
  if (primitives.length > 1) {
    flow = {
      kind: "flow",
      name: seg.flowName,
      ...(input.client ? { client: input.client } : {}),
      description: seg.flowDescription,
      params: paramsUsedIn(JSON.stringify(primitives.map((p) => [p.steps, p.postCondition]))),
      calls: primitives.map((p) => ({
        skill: p.name,
        params: Object.fromEntries(p.params.map((param) => [param.name, `{{${param.name}}}`])),
      })),
      source,
    };
  }

  return { primitives, flow, playbookNotes: seg.playbookNotes, ...(fallbackReason ? { fallbackReason } : {}) };
}
