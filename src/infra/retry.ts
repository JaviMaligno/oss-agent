import { RateLimitError, isRetryableError } from "./errors.js";
import { logger } from "./logger.js";

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs?: number;
  /** Whether to add jitter to prevent thundering herd (default: true) */
  jitter?: boolean;
  /** Custom predicate to determine if error should be retried */
  shouldRetry?: (error: Error, attempt: number) => boolean;
  /** Callback invoked before each retry attempt */
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "shouldRetry" | "onRetry">> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitter: true,
};

/**
 * Calculate exponential backoff delay with optional jitter
 */
export function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean
): number {
  // Exponential backoff: base * 2^attempt
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const clampedDelay = Math.min(exponentialDelay, maxDelayMs);

  if (jitter) {
    // Add 0-25% random jitter to prevent thundering herd
    const jitterFactor = 1 + Math.random() * 0.25;
    return Math.floor(clampedDelay * jitterFactor);
  }

  return clampedDelay;
}

/**
 * Sleep for the specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 *
 * @param fn - The async function to retry
 * @param options - Retry configuration options
 * @returns The result of the function
 * @throws The last error if all retries are exhausted
 */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      const shouldRetry = opts.shouldRetry
        ? opts.shouldRetry(lastError, attempt)
        : isRetryableError(lastError);

      // If this was the last attempt or error is not retryable, throw
      if (attempt >= opts.maxRetries || !shouldRetry) {
        throw lastError;
      }

      // Calculate delay
      const delayMs = calculateBackoff(attempt, opts.baseDelayMs, opts.maxDelayMs, opts.jitter);

      // Invoke callback if provided
      if (opts.onRetry) {
        opts.onRetry(lastError, attempt + 1, delayMs);
      } else {
        logger.debug(
          `Retry ${attempt + 1}/${opts.maxRetries} after ${delayMs}ms: ${lastError.message}`
        );
      }

      await sleep(delayMs);
    }
  }

  // Should never reach here, but TypeScript needs this
  throw lastError ?? new Error("Retry failed with unknown error");
}

/**
 * Retry a function with exponential backoff, respecting RateLimitError.retryAfter
 *
 * This variant will use the retryAfter value from RateLimitError if available,
 * falling back to exponential backoff for other errors.
 *
 * @param fn - The async function to retry
 * @param options - Retry configuration options
 * @returns The result of the function
 * @throws The last error if all retries are exhausted
 */
export async function retryWithRateLimit<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      const shouldRetry = opts.shouldRetry
        ? opts.shouldRetry(lastError, attempt)
        : isRetryableError(lastError) || lastError instanceof RateLimitError;

      // If this was the last attempt or error is not retryable, throw
      if (attempt >= opts.maxRetries || !shouldRetry) {
        throw lastError;
      }

      // Calculate delay - use retryAfter for rate limits, otherwise exponential backoff
      let delayMs: number;
      if (lastError instanceof RateLimitError && lastError.retryAfter !== undefined) {
        // retryAfter is in seconds, convert to milliseconds
        delayMs = lastError.retryAfter * 1000;
        logger.debug(`Rate limited, waiting ${delayMs}ms (from retryAfter)`);
      } else {
        delayMs = calculateBackoff(attempt, opts.baseDelayMs, opts.maxDelayMs, opts.jitter);
      }

      // Invoke callback if provided
      if (opts.onRetry) {
        opts.onRetry(lastError, attempt + 1, delayMs);
      } else {
        logger.debug(
          `Retry ${attempt + 1}/${opts.maxRetries} after ${delayMs}ms: ${lastError.message}`
        );
      }

      await sleep(delayMs);
    }
  }

  // Should never reach here, but TypeScript needs this
  throw lastError ?? new Error("Retry failed with unknown error");
}

/**
 * Create a retry wrapper with pre-configured options
 *
 * @param defaultOptions - Default options for all retries
 * @returns A retry function with the default options applied
 */
export function createRetry(defaultOptions: RetryOptions) {
  return <T>(fn: () => Promise<T>, overrideOptions: RetryOptions = {}): Promise<T> =>
    retry(fn, { ...defaultOptions, ...overrideOptions });
}

/**
 * Create a rate-limit-aware retry wrapper with pre-configured options
 *
 * @param defaultOptions - Default options for all retries
 * @returns A retry function with the default options applied
 */
export function createRetryWithRateLimit(defaultOptions: RetryOptions) {
  return <T>(fn: () => Promise<T>, overrideOptions: RetryOptions = {}): Promise<T> =>
    retryWithRateLimit(fn, { ...defaultOptions, ...overrideOptions });
}
