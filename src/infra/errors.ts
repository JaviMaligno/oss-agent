export class OSSAgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
    public readonly isRetryable: boolean = false
  ) {
    super(message);
    this.name = "OSSAgentError";
  }
}

export class ConfigurationError extends OSSAgentError {
  constructor(message: string, cause?: Error) {
    super(message, "CONFIGURATION_ERROR", cause);
    this.name = "ConfigurationError";
  }
}

export class BudgetExceededError extends OSSAgentError {
  constructor(
    message: string,
    public readonly currentSpend: number,
    public readonly limit: number
  ) {
    super(message, "BUDGET_EXCEEDED");
    this.name = "BudgetExceededError";
  }
}

export class GitOperationError extends OSSAgentError {
  constructor(message: string, cause?: Error) {
    super(message, "GIT_OPERATION_ERROR", cause);
    this.name = "GitOperationError";
  }
}

export class AIProviderError extends OSSAgentError {
  constructor(message: string, cause?: Error) {
    super(message, "AI_PROVIDER_ERROR", cause);
    this.name = "AIProviderError";
  }
}

export class IssueParsingError extends OSSAgentError {
  constructor(message: string, cause?: Error) {
    super(message, "ISSUE_PARSING_ERROR", cause);
    this.name = "IssueParsingError";
  }
}

export class RateLimitError extends OSSAgentError {
  constructor(
    message: string,
    public readonly retryAfter?: number
  ) {
    super(message, "RATE_LIMIT_ERROR");
    this.name = "RateLimitError";
  }
}

export class StateError extends OSSAgentError {
  constructor(message: string, cause?: Error) {
    super(message, "STATE_ERROR", cause);
    this.name = "StateError";
  }
}

export class NetworkError extends OSSAgentError {
  constructor(message: string, cause?: Error) {
    super(message, "NETWORK_ERROR", cause, true); // Retryable by default
    this.name = "NetworkError";
  }
}

export class TimeoutError extends OSSAgentError {
  constructor(
    message: string,
    public readonly operationType: string,
    public readonly timeoutMs: number
  ) {
    super(message, "TIMEOUT_ERROR", undefined, true); // Retryable by default
    this.name = "TimeoutError";
  }
}

export class CircuitOpenError extends OSSAgentError {
  constructor(
    public readonly operationType: string,
    public readonly reopenAt: Date
  ) {
    super(
      `Circuit breaker open for ${operationType}, will retry at ${reopenAt.toISOString()}`,
      "CIRCUIT_OPEN",
      undefined,
      false // Not retryable - wait for circuit to close
    );
    this.name = "CircuitOpenError";
  }
}

export function isOSSAgentError(error: unknown): error is OSSAgentError {
  return error instanceof OSSAgentError;
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof OSSAgentError) {
    return error.isRetryable;
  }
  // Consider certain error types as retryable
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("etimedout") ||
      msg.includes("socket hang up") ||
      msg.includes("network")
    );
  }
  return false;
}
