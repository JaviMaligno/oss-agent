import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  OSSAgentError,
  ConfigurationError,
  BudgetExceededError,
  GitOperationError,
  AIProviderError,
  IssueParsingError,
  RateLimitError,
  StateError,
  NetworkError,
  TimeoutError,
  CircuitOpenError,
} from "../../infra/errors.js";

/**
 * Maps oss-agent error hierarchy to MCP errors
 */
export function mapToMCPError(error: unknown): McpError {
  // Configuration errors -> InvalidRequest
  if (error instanceof ConfigurationError) {
    return new McpError(ErrorCode.InvalidRequest, error.message, {
      code: error.code,
    });
  }

  // Budget exceeded -> InvalidRequest with details
  if (error instanceof BudgetExceededError) {
    return new McpError(ErrorCode.InvalidRequest, error.message, {
      code: error.code,
      currentSpend: error.currentSpend,
      limit: error.limit,
    });
  }

  // Rate limit -> InvalidRequest with retry info
  if (error instanceof RateLimitError) {
    return new McpError(ErrorCode.InvalidRequest, error.message, {
      code: error.code,
      retryAfter: error.retryAfter,
    });
  }

  // Issue parsing -> InvalidRequest
  if (error instanceof IssueParsingError) {
    return new McpError(ErrorCode.InvalidRequest, error.message, {
      code: error.code,
    });
  }

  // State errors -> InvalidRequest
  if (error instanceof StateError) {
    return new McpError(ErrorCode.InvalidRequest, error.message, {
      code: error.code,
    });
  }

  // Timeout -> InternalError with details
  if (error instanceof TimeoutError) {
    return new McpError(ErrorCode.InternalError, error.message, {
      code: error.code,
      operationType: error.operationType,
      timeoutMs: error.timeoutMs,
      isRetryable: error.isRetryable,
    });
  }

  // Circuit breaker open -> InternalError with retry info
  if (error instanceof CircuitOpenError) {
    return new McpError(ErrorCode.InternalError, error.message, {
      code: error.code,
      operationType: error.operationType,
      reopenAt: error.reopenAt.toISOString(),
      isRetryable: false,
    });
  }

  // Network error -> InternalError (retryable)
  if (error instanceof NetworkError) {
    return new McpError(ErrorCode.InternalError, error.message, {
      code: error.code,
      isRetryable: error.isRetryable,
    });
  }

  // Git operation error -> InternalError
  if (error instanceof GitOperationError) {
    return new McpError(ErrorCode.InternalError, error.message, {
      code: error.code,
    });
  }

  // AI provider error -> InternalError
  if (error instanceof AIProviderError) {
    return new McpError(ErrorCode.InternalError, error.message, {
      code: error.code,
    });
  }

  // Generic OSSAgentError
  if (error instanceof OSSAgentError) {
    return new McpError(ErrorCode.InternalError, error.message, {
      code: error.code,
      isRetryable: error.isRetryable,
    });
  }

  // Standard Error
  if (error instanceof Error) {
    return new McpError(ErrorCode.InternalError, error.message);
  }

  // Unknown error type
  return new McpError(ErrorCode.InternalError, String(error));
}

/**
 * Wraps a function to catch errors and convert them to MCP errors
 */
export function withMCPErrorHandling<T extends (...args: unknown[]) => Promise<unknown>>(fn: T): T {
  return (async (...args: unknown[]) => {
    try {
      return await fn(...args);
    } catch (error) {
      throw mapToMCPError(error);
    }
  }) as T;
}

/**
 * Error response helper for tool results
 */
export function createErrorResult(error: unknown): {
  success: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
} {
  const mcpError = mapToMCPError(error);
  const details = mcpError.data as Record<string, unknown> | undefined;

  const result: {
    success: false;
    error: { code: string; message: string; details?: Record<string, unknown> };
  } = {
    success: false,
    error: {
      code: mcpError.code.toString(),
      message: mcpError.message,
    },
  };

  if (details !== undefined) {
    result.error.details = details;
  }

  return result;
}

/**
 * Success response helper for tool results
 */
export function createSuccessResult<T>(data: T): { success: true; data: T } {
  return {
    success: true,
    data,
  };
}
