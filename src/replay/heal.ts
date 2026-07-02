import type { OpenAI } from "openai";
import { withLlmRetry } from "../llm-client.js";
import type { SkillStep } from "../compiler/skill.types.js";

/**
 * Self-heal: when a replayed step fails (site redeploy renamed a button,
 * selector churned), the LLM wakes up for just the broken step -- it gets the
 * failing step template, the error, and a fresh page snapshot, and returns a
 * patched step. The patch is persisted to the skill file, so one heal fixes
 * every flow that composes the skill. This is the partial-plan recovery that
 * the v1 plan-then-execute experiment lacked.
 */

export interface HealInput {
  skillName: string;
  skillDescription: string;
  stepIndex: number;
  /** The parameterized step template that failed ({{param}} placeholders intact). */
  step: SkillStep;
  /** Runtime params, so the healer knows what the placeholders resolve to. */
  params: Record<string, string>;
  error: string;
  /** Fresh accessibility snapshot of the page ("" when unavailable). */
  snapshot: string;
  /** Tool names that exist in this run; the patch must use one of them. */
  availableTools: string[];
}

export type Healer = (input: HealInput) => Promise<SkillStep>;

export class HealError extends Error {}

/** Rejects patches that could not possibly execute; policy gating happens at execution. */
export function validatePatch(patch: Partial<SkillStep>, availableTools: string[]): SkillStep {
  if (!patch.tool || typeof patch.tool !== "string") throw new HealError("patch has no tool");
  if (!availableTools.includes(patch.tool)) throw new HealError(`patch tool "${patch.tool}" does not exist`);
  if (!patch.args || typeof patch.args !== "object" || Array.isArray(patch.args)) throw new HealError("patch has no args object");
  return {
    tool: patch.tool,
    args: patch.args as Record<string, unknown>,
    ...(patch.locator && typeof patch.locator.role === "string" && typeof patch.locator.name === "string"
      ? { locator: { role: patch.locator.role, name: patch.locator.name } }
      : {}),
  };
}

const HEAL_SYSTEM = `You repair one broken step of a compiled browser-automation skill.
Input JSON: { skillName, skillDescription, stepIndex, step, params, error, snapshot, availableTools }.
- "step" is the failing step template; string values may contain {{param}} placeholders which are substituted at runtime from "params".
- "snapshot" lists the page's visible interactive elements as: ref role "accessible name" [state].
- The page changed since the skill was recorded (renamed button, changed selector, moved element). Find the element on the CURRENT page that serves the step's original purpose.
Return STRICT JSON only -- the replacement step: { "tool": "...", "args": { ... }, "locator": { "role": "...", "name": "..." } }.
Rules:
- tool MUST be one of availableTools. Prefer the original tool; prefer targeting by role+name (browser__click / browser__fill accept "role" and "name" args) over CSS selectors.
- Keep the SAME {{param}} placeholders for values that came from parameters -- the patch is saved back into the skill and must work for future parameter values, not just these.
- Do NOT use snapshot refs (e1, e2...) in the patch: refs expire, the patch must not.
- Output ONLY the JSON object.`;

/** LLM-backed healer: one call per broken step. */
export function llmHealer(client: OpenAI, model: string): Healer {
  return async (input) => {
    const res = await withLlmRetry(() =>
      client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: HEAL_SYSTEM },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
    );
    const text = res.choices[0]?.message?.content ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as Partial<SkillStep>;
    return validatePatch(parsed, input.availableTools);
  };
}
