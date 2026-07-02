import { describe, expect, it, vi } from "vitest";
import { withLlmRetry } from "../src/llm-client.js";

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const instantSleep = () => Promise.resolve();

describe("withLlmRetry", () => {
  it("retries transient 5xx/429 errors with backoff and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(statusError(500, "internal error"))
      .mockRejectedValueOnce(statusError(429, "rate limited"))
      .mockResolvedValueOnce("done");
    const onRetry = vi.fn();

    const result = await withLlmRetry(fn, { sleep: instantSleep, onRetry });

    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, { attempt: 1, error: "internal error", delayMs: 1000 });
    expect(onRetry).toHaveBeenNthCalledWith(2, { attempt: 2, error: "rate limited", delayMs: 2000 });
  });

  it("retries plain network errors (no status)", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce("done");
    await expect(withLlmRetry(fn, { sleep: instantSleep })).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient 4xx errors", async () => {
    const fn = vi.fn().mockRejectedValue(statusError(400, "invalid request"));
    await expect(withLlmRetry(fn, { sleep: instantSleep })).rejects.toThrow("invalid request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured number of attempts", async () => {
    const fn = vi.fn().mockRejectedValue(statusError(503, "unavailable"));
    await expect(withLlmRetry(fn, { attempts: 3, sleep: instantSleep })).rejects.toThrow("unavailable");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("abandons a hung call once the per-attempt timeout elapses", async () => {
    const fn = vi.fn().mockImplementation(() => new Promise(() => {}));
    await expect(withLlmRetry(fn, { attempts: 1, timeoutMs: 20, sleep: instantSleep })).rejects.toThrow(
      /timed out after 20ms/,
    );
  });
});
