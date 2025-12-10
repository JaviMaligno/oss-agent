export class OSSAgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
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

export function isOSSAgentError(error: unknown): error is OSSAgentError {
  return error instanceof OSSAgentError;
}
