import type { OpenAI } from "openai";
import { withLlmRetry } from "../llm-client.js";
import { detectLiterals, parameterize } from "./parameterize.js";
import { assertCompilable, extractTrajectory, type RunEvent } from "./trajectory.js";
import type { Skill, SkillParam, SkillPostCondition, SkillStep } from "./skill.types.js";

export interface NamerInput {
  task: string;
  steps: SkillStep[];
  postCondition: SkillPostCondition;
  /** The detected literal values that will become parameters. */
  literals: string[];
}

export interface NamerOutput {
  /** snake_case skill name, e.g. "open_product_by_sku". */
  skillName: string;
  /** One-sentence description of what the skill does. */
  description: string;
  /** Maps each detected literal value -> a param name, e.g. { "901384900": "sku" }. */
  paramNames: Record<string, string>;
}

export type Namer = (input: NamerInput) => Promise<NamerOutput>;

/**
 * Offline fallback namer: derives a skill name from the task and names params
 * positionally (param1, param2...). Deterministic; used when no LLM is
 * available or for tests that don't care about semantic names.
 */
export const heuristicNamer: Namer = async ({ task, literals }) => {
  const slug =
    task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .split("_")
      .slice(0, 6)
      .join("_") || "skill";
  const paramNames: Record<string, string> = {};
  literals.forEach((lit, i) => {
    paramNames[lit] = `param${i + 1}`;
  });
  return { skillName: slug, description: task, paramNames };
};

const NAMER_SYSTEM = `You name a reusable automation "skill" compiled from one successful run.
Given the task, the executed steps, and the literal values that will be turned into parameters, return STRICT JSON:
{ "skillName": "snake_case_verb_noun", "description": "one sentence", "paramNames": { "<literal>": "snake_case_param" } }
Rules: skillName is a short snake_case verb_noun (e.g. open_product_by_sku, set_attribute). Every literal in the input MUST get a paramNames entry; choose a meaningful name from how the value is used in the task (an id/code the task acts on -> its noun like "sku"; a value being written -> the field name like "ean"). Output ONLY the JSON object, no prose.`;

/** LLM-backed namer: one cheap call that returns skill/param names as JSON. */
export function llmNamer(client: OpenAI, model: string): Namer {
  return async ({ task, steps, postCondition, literals }) => {
    const user = JSON.stringify({ task, steps, postCondition, literals });
    const res = await withLlmRetry(() =>
      client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: NAMER_SYSTEM },
          { role: "user", content: user },
        ],
      }),
    );
    const text = res.choices[0]?.message?.content ?? "";
    const parsed = parseNamerJson(text);
    // Guarantee every literal is covered even if the model missed one.
    for (const lit of literals) {
      if (!parsed.paramNames[lit]) parsed.paramNames[lit] = `param${literals.indexOf(lit) + 1}`;
    }
    return parsed;
  };
}

function parseNamerJson(text: string): NamerOutput {
  const match = text.match(/\{[\s\S]*\}/);
  const raw = match ? match[0] : text;
  const obj = JSON.parse(raw) as Partial<NamerOutput>;
  if (!obj.skillName || typeof obj.skillName !== "string") throw new Error("namer response missing skillName");
  return {
    skillName: obj.skillName,
    description: obj.description ?? "",
    paramNames: obj.paramNames ?? {},
  };
}

export interface CompileInput {
  events: RunEvent[];
  runId: string;
  task: string;
  model: string;
  client?: string;
  metaStatus?: string;
  namer: Namer;
}

/** Compiles one run's events into a parameterized, verifiable Skill. */
export async function compileRun(input: CompileInput): Promise<Skill> {
  assertCompilable(input.events, input.metaStatus);
  const { steps, postCondition } = extractTrajectory(input.events);

  const literals = detectLiterals(input.task, steps, postCondition);
  const naming = await input.namer({ task: input.task, steps, postCondition, literals });

  const substituted = parameterize(steps, postCondition, naming.paramNames);

  const params: SkillParam[] = literals.map((lit) => ({
    name: naming.paramNames[lit] ?? lit,
    example: lit,
  }));

  return {
    name: naming.skillName,
    ...(input.client ? { client: input.client } : {}),
    description: naming.description,
    params,
    steps: substituted.steps,
    postCondition: substituted.postCondition,
    source: {
      runId: input.runId,
      task: input.task,
      model: input.model,
      compiledAt: new Date().toISOString(),
    },
  };
}
