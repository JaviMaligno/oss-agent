import { logger } from "./logger.js";

export interface WatchdogContext {
  /** Type of operation being watched */
  operationType: string;
  /** When the operation started */
  startedAt: Date;
  /** When the last heartbeat was received */
  lastHeartbeat: Date;
  /** Optional metadata about the operation */
  metadata: Record<string, unknown> | undefined;
}

export interface WatchdogOptions {
  /** Timeout in milliseconds before triggering (default: 300000 = 5min) */
  timeoutMs: number;
  /** Callback invoked when timeout is reached */
  onTimeout: (context: WatchdogContext) => void;
  /** Optional callback on each heartbeat */
  onHeartbeat?: (context: WatchdogContext) => void;
}

/**
 * Watchdog timer for detecting hung operations
 *
 * The watchdog monitors long-running operations and triggers a callback
 * if no heartbeat is received within the timeout period.
 *
 * Usage:
 * ```typescript
 * const watchdog = new Watchdog('ai-query', {
 *   timeoutMs: 60000,
 *   onTimeout: (ctx) => {
 *     console.log(`Operation ${ctx.operationType} timed out`);
 *     killHungProcess();
 *   }
 * });
 *
 * watchdog.start({ query: 'some prompt' });
 *
 * // Call periodically to reset timeout
 * watchdog.heartbeat();
 *
 * // When done
 * watchdog.stop();
 * ```
 */
export class Watchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private context: WatchdogContext | undefined;
  private running = false;
  private readonly options: WatchdogOptions;

  constructor(
    private readonly operationType: string,
    options: WatchdogOptions
  ) {
    this.options = options;
  }

  /**
   * Start the watchdog timer
   *
   * @param metadata - Optional metadata to include in context
   */
  start(metadata?: Record<string, unknown>): void {
    if (this.running) {
      logger.warn(`Watchdog for ${this.operationType} already running, resetting`);
      this.stop();
    }

    const now = new Date();
    this.context = {
      operationType: this.operationType,
      startedAt: now,
      lastHeartbeat: now,
      metadata,
    };
    this.running = true;

    this.scheduleTimeout();

    logger.debug(`Watchdog started for ${this.operationType}`, {
      timeoutMs: this.options.timeoutMs,
      metadata,
    });
  }

  /**
   * Signal that the operation is still alive
   *
   * This resets the timeout timer.
   */
  heartbeat(): void {
    if (!this.running || !this.context) {
      return;
    }

    this.context.lastHeartbeat = new Date();

    // Clear and reschedule timeout
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.scheduleTimeout();

    if (this.options.onHeartbeat) {
      this.options.onHeartbeat(this.context);
    }
  }

  /**
   * Stop the watchdog timer
   *
   * Call this when the operation completes successfully.
   */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.running && this.context) {
      const elapsed = Date.now() - this.context.startedAt.getTime();
      logger.debug(`Watchdog stopped for ${this.operationType}`, {
        elapsedMs: elapsed,
      });
    }

    this.running = false;
    this.context = undefined;
  }

  /**
   * Check if the watchdog is currently running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get elapsed time since start in milliseconds
   */
  getElapsedMs(): number {
    if (!this.context) {
      return 0;
    }
    return Date.now() - this.context.startedAt.getTime();
  }

  /**
   * Get time since last heartbeat in milliseconds
   */
  getTimeSinceHeartbeatMs(): number {
    if (!this.context) {
      return 0;
    }
    return Date.now() - this.context.lastHeartbeat.getTime();
  }

  /**
   * Get the current context (if running)
   */
  getContext(): WatchdogContext | undefined {
    return this.context ? { ...this.context } : undefined;
  }

  private scheduleTimeout(): void {
    this.timer = setTimeout(() => {
      if (!this.running || !this.context) {
        return;
      }

      const elapsed = Date.now() - this.context.startedAt.getTime();
      const timeSinceHeartbeat = Date.now() - this.context.lastHeartbeat.getTime();

      logger.warn(`Watchdog timeout for ${this.operationType}`, {
        elapsedMs: elapsed,
        timeSinceHeartbeatMs: timeSinceHeartbeat,
        timeoutMs: this.options.timeoutMs,
        metadata: this.context.metadata,
      });

      // Invoke callback with context
      this.options.onTimeout({ ...this.context });

      // Don't auto-stop - let the callback decide what to do
    }, this.options.timeoutMs);
  }
}

/**
 * Create a watchdog for AI operations with sensible defaults
 */
export function createAIOperationWatchdog(
  onTimeout: (context: WatchdogContext) => void,
  timeoutMs: number = 300000 // 5 minutes default
): Watchdog {
  return new Watchdog("ai-operation", {
    timeoutMs,
    onTimeout,
  });
}

/**
 * Create a watchdog for git operations
 */
export function createGitOperationWatchdog(
  onTimeout: (context: WatchdogContext) => void,
  timeoutMs: number = 60000 // 1 minute default
): Watchdog {
  return new Watchdog("git-operation", {
    timeoutMs,
    onTimeout,
  });
}

/**
 * Wrapper that automatically manages a watchdog for an async operation
 *
 * @param operationType - Type of operation for logging
 * @param fn - The async function to execute
 * @param options - Watchdog options
 * @param heartbeatCallback - Optional function that returns a heartbeat callback to use during execution
 * @returns The result of the function
 */
export async function withWatchdog<T>(
  operationType: string,
  fn: (heartbeat: () => void) => Promise<T>,
  options: WatchdogOptions
): Promise<T> {
  const watchdog = new Watchdog(operationType, options);
  watchdog.start();

  try {
    return await fn(() => watchdog.heartbeat());
  } finally {
    watchdog.stop();
  }
}
