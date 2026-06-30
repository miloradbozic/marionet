import OpenAI from "openai";

export type LlmClient = OpenAI;

const PROVIDERS: Array<{
  prefix: string;
  baseURL: string;
  envVar: string;
}> = [
  { prefix: "deepseek/", baseURL: "https://api.deepseek.com/v1", envVar: "DEEPSEEK_API_KEY" },
  { prefix: "openrouter/", baseURL: "https://openrouter.ai/api/v1", envVar: "OPENROUTER_API_KEY" },
];

/** Returns the OpenAI-compatible client and the bare model name the provider expects. */
export function createLlmClient(model: string): { client: LlmClient; effectiveModel: string } {
  const provider = PROVIDERS.find((p) => model.startsWith(p.prefix));

  if (provider) {
    const apiKey = process.env[provider.envVar];
    if (!apiKey) throw new Error(`${provider.envVar} not set in .env (required for model "${model}")`);
    return {
      client: new OpenAI({ apiKey, baseURL: provider.baseURL }),
      effectiveModel: model.slice(provider.prefix.length),
    };
  }

  // Default: Anthropic direct API (claude-* models)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error(`ANTHROPIC_API_KEY not set in .env (required for model "${model}")`);
  return {
    client: new OpenAI({
      apiKey,
      baseURL: "https://api.anthropic.com/v1",
      defaultHeaders: { "anthropic-version": "2023-06-01" },
    }),
    effectiveModel: model,
  };
}

export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  pricing: { input: number; output: number } | undefined,
): number {
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}
