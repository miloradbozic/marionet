import Anthropic from "@anthropic-ai/sdk";

// $ per million tokens. Update if pricing changes or a different model is configured.
const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

export function createAnthropicClient(): Anthropic {
  return new Anthropic();
}

export function estimateCostUsd(model: string, usage: Anthropic.Usage): number {
  const pricing = PRICING_PER_MTOK[model];
  if (!pricing) return 0;
  return (usage.input_tokens / 1_000_000) * pricing.input + (usage.output_tokens / 1_000_000) * pricing.output;
}
