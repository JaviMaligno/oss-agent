import { describe, it, expect, vi } from "vitest";
import { retry, retryWithRateLimit, calculateBackoff } from "../../src/infra/retry.js";
import { RateLimitError } from "../../src/infra/errors.js";

describe("retry", () => {
  describe("calculateBackoff", () => {
    it("should calculate exponential backoff", () => {
      const base = 1000;
      const max = 30000;

      expect(calculateBackoff(0, base, max, false)).toBe(1000);
      expect(calculateBackoff(1, base, max, false)).toBe(2000);
      expect(calculateBackoff(2, base, max, false)).toBe(4000);
      expect(calculateBackoff(3, base, max, false)).toBe(8000);
    });

    it("should cap at max delay", () => {
      const base = 1000;
      const max = 5000;

      expect(calculateBackoff(0, base, max, false)).toBe(1000);
      expect(calculateBackoff(1, base, max, false)).toBe(2000);
      expect(calculateBackoff(2, base, max, false)).toBe(4000);
      expect(calculateBackoff(3, base, max, false)).toBe(5000); // Capped
      expect(calculateBackoff(10, base, max, false)).toBe(5000); // Still capped
    });

    it("should add jitter when enabled", () => {
      const base = 1000;
      const max = 30000;

      // Run multiple times to verify randomness
      const results = new Set<number>();
      for (let i = 0; i < 10; i++) {
        results.add(calculateBackoff(0, base, max, true));
      }

      // Should have some variation (though not guaranteed)
      // At minimum, value should be >= 1000 (no negative jitter)
      for (const result of results) {
        expect(result).toBeGreaterThanOrEqual(1000);
        expect(result).toBeLessThanOrEqual(1250); // Max 25% jitter
      }
    });
  });

  describe("retry function", () => {
    it("should succeed on first try", async () => {
      const fn = vi.fn().mockResolvedValue("success");

      const result = await retry(fn);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should retry on failure and eventually succeed when shouldRetry returns true", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockResolvedValue("success");

      // Need to provide shouldRetry since default only retries specific error types
      const result = await retry(fn, {
        maxRetries: 3,
        baseDelayMs: 10,
        shouldRetry: () => true,
      });

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should throw after max retries when shouldRetry is true", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("always fails"));

      await expect(
        retry(fn, { maxRetries: 2, baseDelayMs: 10, shouldRetry: () => true })
      ).rejects.toThrow("always fails");

      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it("should not retry by default for generic errors", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("generic error"));

      await expect(retry(fn, { maxRetries: 3, baseDelayMs: 10 })).rejects.toThrow("generic error");

      // Only initial call, no retries since isRetryableError returns false for generic errors
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should call onRetry callback", async () => {
      const fn = vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValue("success");

      const onRetry = vi.fn();

      await retry(fn, {
        maxRetries: 3,
        baseDelayMs: 10,
        shouldRetry: () => true,
        onRetry,
      });

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, expect.any(Number));
    });

    it("should respect shouldRetry predicate", async () => {
      const nonRetryableError = new Error("non-retryable");

      const fn = vi.fn().mockRejectedValue(nonRetryableError);

      const shouldRetry = vi.fn((error: Error) => error.message === "retryable");

      await expect(
        retry(fn, {
          maxRetries: 3,
          baseDelayMs: 10,
          shouldRetry,
        })
      ).rejects.toThrow("non-retryable");

      // Only initial call, no retries since shouldRetry returns false
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should only retry when shouldRetry returns true", async () => {
      const fn = vi.fn().mockRejectedValueOnce(new Error("retryable")).mockResolvedValue("success");

      const shouldRetry = vi.fn((error: Error) => error.message === "retryable");

      const result = await retry(fn, {
        maxRetries: 3,
        baseDelayMs: 10,
        shouldRetry,
      });

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("retryWithRateLimit", () => {
    it("should respect RateLimitError.retryAfter", async () => {
      const startTime = Date.now();
      const retryAfterMs = 50;

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new RateLimitError("rate limited", retryAfterMs / 1000))
        .mockResolvedValue("success");

      const result = await retryWithRateLimit(fn, {
        maxRetries: 1,
        baseDelayMs: 10,
      });

      const elapsed = Date.now() - startTime;

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
      // Should have waited at least retryAfter
      expect(elapsed).toBeGreaterThanOrEqual(retryAfterMs - 10); // Allow some tolerance
    });

    it("should use shouldRetry predicate for RateLimitError", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new RateLimitError("rate limited", 0.01))
        .mockResolvedValue("success");

      // RateLimitError is retryable by default in retryWithRateLimit
      const result = await retryWithRateLimit(fn, {
        maxRetries: 1,
        baseDelayMs: 10,
      });

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should not retry generic errors by default", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("generic error"));

      await expect(retryWithRateLimit(fn, { maxRetries: 1, baseDelayMs: 10 })).rejects.toThrow(
        "generic error"
      );

      // Only initial call - generic errors are not retryable by default
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
