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

export interface LlmRetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Per-attempt ceiling before the call is abandoned and retried. Default 120s. */
  timeoutMs?: number;
  onRetry?: (info: { attempt: number; error: string; delayMs: number }) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

function isRetryable(err: unknown): boolean {
  // OpenAI SDK errors carry a numeric `status`; plain network failures don't.
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  return true; // timeouts, connection resets, DNS failures
}

/**
 * Retries transient LLM API failures (429/5xx/network/timeout) with
 * exponential backoff. Non-retryable errors (4xx like invalid request or
 * bad auth) are rethrown immediately.
 */
export async function withLlmRetry<T>(fn: () => Promise<T>, opts: LlmRetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`LLM call timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts) throw err;
      const delayMs = 1000 * 2 ** (attempt - 1);
      opts.onRetry?.({ attempt, error: err instanceof Error ? err.message : String(err), delayMs });
      await sleep(delayMs);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError;
}
