import { CircuitOpenError } from "./errors.js";
import { logger } from "./logger.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Number of successes in half-open state before closing (default: 2) */
  successThreshold?: number;
  /** How long to stay open before transitioning to half-open (ms, default: 60000) */
  openDurationMs?: number;
  /** Callback when circuit state changes */
  onStateChange?: (from: CircuitState, to: CircuitState, operationType: string) => void;
}

const DEFAULT_OPTIONS: Required<Omit<CircuitBreakerOptions, "onStateChange">> = {
  failureThreshold: 5,
  successThreshold: 2,
  openDurationMs: 60000,
};

/**
 * Circuit breaker implementation to prevent cascading failures
 *
 * States:
 * - closed: Normal operation, requests pass through
 * - open: Circuit is tripped, requests fail immediately with CircuitOpenError
 * - half-open: Testing state, limited requests allowed to test recovery
 *
 * State transitions:
 * - closed -> open: When consecutive failures >= failureThreshold
 * - open -> half-open: After openDurationMs expires
 * - half-open -> closed: After successThreshold consecutive successes
 * - half-open -> open: On any failure
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: Date | undefined;
  private openedAt: Date | undefined;
  private readonly options: Required<Omit<CircuitBreakerOptions, "onStateChange">>;
  private readonly onStateChange?: CircuitBreakerOptions["onStateChange"];

  constructor(
    private readonly operationType: string,
    options: CircuitBreakerOptions = {}
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.onStateChange = options.onStateChange;
  }

  /**
   * Execute a function through the circuit breaker
   *
   * @throws CircuitOpenError if circuit is open
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we should transition from open to half-open
    if (this.state === "open") {
      if (this.shouldTransitionToHalfOpen()) {
        this.transitionTo("half-open");
      } else {
        const reopenAt = new Date(
          (this.openedAt?.getTime() ?? Date.now()) + this.options.openDurationMs
        );
        throw new CircuitOpenError(this.operationType, reopenAt);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Get the current circuit state
   */
  getState(): CircuitState {
    // Auto-transition to half-open if time has passed
    if (this.state === "open" && this.shouldTransitionToHalfOpen()) {
      this.transitionTo("half-open");
    }
    return this.state;
  }

  /**
   * Get the current failure count
   */
  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Get the time of the last failure
   */
  getLastFailureTime(): Date | undefined {
    return this.lastFailureTime;
  }

  /**
   * Get the time when the circuit will reopen (if open)
   */
  getReopenTime(): Date | undefined {
    if (this.state !== "open" || !this.openedAt) {
      return undefined;
    }
    return new Date(this.openedAt.getTime() + this.options.openDurationMs);
  }

  /**
   * Manually reset the circuit to closed state
   */
  reset(): void {
    this.transitionTo("closed");
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = undefined;
    this.openedAt = undefined;
  }

  /**
   * Manually trip the circuit to open state
   */
  trip(): void {
    this.transitionTo("open");
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.successCount++;
      if (this.successCount >= this.options.successThreshold) {
        this.transitionTo("closed");
        this.failureCount = 0;
        this.successCount = 0;
      }
    } else if (this.state === "closed") {
      // Reset failure count on success in closed state
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.lastFailureTime = new Date();

    if (this.state === "half-open") {
      // Any failure in half-open immediately opens the circuit
      this.transitionTo("open");
      this.successCount = 0;
    } else if (this.state === "closed") {
      this.failureCount++;
      if (this.failureCount >= this.options.failureThreshold) {
        this.transitionTo("open");
      }
    }
  }

  private shouldTransitionToHalfOpen(): boolean {
    if (this.state !== "open" || !this.openedAt) {
      return false;
    }
    const elapsed = Date.now() - this.openedAt.getTime();
    return elapsed >= this.options.openDurationMs;
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) {
      return;
    }

    const oldState = this.state;
    this.state = newState;

    if (newState === "open") {
      this.openedAt = new Date();
      logger.warn(`Circuit breaker OPEN for ${this.operationType}`, {
        failures: this.failureCount,
        willRetryAt: new Date(Date.now() + this.options.openDurationMs).toISOString(),
      });
    } else if (newState === "half-open") {
      this.successCount = 0;
      logger.info(`Circuit breaker half-open for ${this.operationType}, testing recovery`);
    } else if (newState === "closed") {
      this.openedAt = undefined;
      logger.info(`Circuit breaker CLOSED for ${this.operationType}, recovered`);
    }

    if (this.onStateChange) {
      this.onStateChange(oldState, newState, this.operationType);
    }
  }
}

/**
 * Pre-defined operation types for circuit breakers
 */
export const CIRCUIT_OPERATIONS = {
  AI_PROVIDER: "ai-provider",
  GITHUB_API: "github-api",
  GIT_OPERATIONS: "git-operations",
  GITLAB_API: "gitlab-api",
  BITBUCKET_API: "bitbucket-api",
  JIRA_API: "jira-api",
  LINEAR_API: "linear-api",
} as const;

export type CircuitOperation = (typeof CIRCUIT_OPERATIONS)[keyof typeof CIRCUIT_OPERATIONS];

/**
 * Registry for managing circuit breakers by operation type
 *
 * This singleton ensures that circuit breaker state is shared across
 * all calls to the same operation type.
 */
export class CircuitBreakerRegistry {
  private static instance: CircuitBreakerRegistry;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private defaultOptions: CircuitBreakerOptions = {};

  private constructor() {}

  static getInstance(): CircuitBreakerRegistry {
    if (!CircuitBreakerRegistry.instance) {
      CircuitBreakerRegistry.instance = new CircuitBreakerRegistry();
    }
    return CircuitBreakerRegistry.instance;
  }

  /**
   * Set default options for all circuit breakers
   */
  setDefaultOptions(options: CircuitBreakerOptions): void {
    this.defaultOptions = options;
  }

  /**
   * Get or create a circuit breaker for an operation type
   */
  get(operationType: string, options?: CircuitBreakerOptions): CircuitBreaker {
    let breaker = this.breakers.get(operationType);
    if (!breaker) {
      breaker = new CircuitBreaker(operationType, { ...this.defaultOptions, ...options });
      this.breakers.set(operationType, breaker);
    }
    return breaker;
  }

  /**
   * Get all registered circuit breakers
   */
  getAll(): Map<string, CircuitBreaker> {
    return new Map(this.breakers);
  }

  /**
   * Reset all circuit breakers to closed state
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Get status summary of all circuit breakers
   */
  getStatus(): Record<
    string,
    { state: CircuitState; failures: number; reopenAt: string | undefined }
  > {
    const status: Record<
      string,
      { state: CircuitState; failures: number; reopenAt: string | undefined }
    > = {};
    for (const [type, breaker] of this.breakers) {
      const reopenTime = breaker.getReopenTime();
      status[type] = {
        state: breaker.getState(),
        failures: breaker.getFailureCount(),
        reopenAt: reopenTime?.toISOString(),
      };
    }
    return status;
  }
}

// Export singleton getter for convenience
export function getCircuitBreaker(
  operationType: string,
  options?: CircuitBreakerOptions
): CircuitBreaker {
  return CircuitBreakerRegistry.getInstance().get(operationType, options);
}
