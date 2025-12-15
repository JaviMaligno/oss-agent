/**
 * MCP Hardening Module
 *
 * Provides circuit breaker and watchdog integration for MCP tools.
 * Wraps tool handlers with resilience patterns for production reliability.
 */

import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  type CircuitState,
} from "../infra/circuit-breaker.js";
import { Watchdog, type WatchdogContext } from "../infra/watchdog.js";
import { logger } from "../infra/logger.js";
import type { MCPContext, ToolResult } from "./types.js";
import type { ToolHandler } from "./tools/index.js";

/**
 * MCP-specific circuit breaker operation types
 */
export const MCP_CIRCUIT_OPERATIONS = {
  WORK_ON_ISSUE: "mcp-work-on-issue",
  ITERATE_ON_FEEDBACK: "mcp-iterate-on-feedback",
  RESUME_SESSION: "mcp-resume-session",
  WATCH_PRS: "mcp-watch-prs",
  RUN_AUTONOMOUS: "mcp-run-autonomous",
  WORK_PARALLEL: "mcp-work-parallel",
  DISCOVER_PROJECTS: "mcp-discover-projects",
  SUGGEST_ISSUES: "mcp-suggest-issues",
} as const;

export type MCPCircuitOperation =
  (typeof MCP_CIRCUIT_OPERATIONS)[keyof typeof MCP_CIRCUIT_OPERATIONS];

/**
 * Hardening configuration for MCP tools
 */
export interface MCPHardeningConfig {
  /** Enable circuit breakers (default: true) */
  circuitBreakerEnabled: boolean;
  /** Enable watchdog timeouts (default: true) */
  watchdogEnabled: boolean;
  /** Circuit breaker settings */
  circuitBreaker: {
    /** Failures before opening circuit (default: 3) */
    failureThreshold: number;
    /** Successes needed to close circuit (default: 2) */
    successThreshold: number;
    /** How long circuit stays open (ms, default: 60000) */
    openDurationMs: number;
  };
  /** Default watchdog timeout (ms, default: 300000 = 5min) */
  defaultTimeoutMs: number;
  /** Per-tool timeout overrides */
  toolTimeouts: Record<string, number>;
}

/**
 * Default hardening configuration
 */
export const DEFAULT_MCP_HARDENING_CONFIG: MCPHardeningConfig = {
  circuitBreakerEnabled: true,
  watchdogEnabled: true,
  circuitBreaker: {
    failureThreshold: 3,
    successThreshold: 2,
    openDurationMs: 60000,
  },
  defaultTimeoutMs: 300000, // 5 minutes
  toolTimeouts: {
    work_on_issue: 600000, // 10 minutes
    iterate_on_feedback: 300000, // 5 minutes
    resume_session: 600000, // 10 minutes
    watch_prs: 120000, // 2 minutes
    run_autonomous: 1800000, // 30 minutes
    work_parallel: 1800000, // 30 minutes
    discover_projects: 120000, // 2 minutes
    suggest_issues: 60000, // 1 minute
    queue_list: 10000, // 10 seconds
    queue_add: 10000, // 10 seconds
    get_status: 30000, // 30 seconds
    get_config: 5000, // 5 seconds
    cleanup_worktrees: 60000, // 1 minute
  },
};

/**
 * Hardened tool handler that wraps another handler with circuit breaker and watchdog
 */
export class HardenedToolHandler {
  private readonly circuitBreaker: CircuitBreaker;
  private readonly timeoutMs: number;
  private readonly config: MCPHardeningConfig;

  constructor(
    private readonly toolName: string,
    private readonly handler: ToolHandler,
    config: Partial<MCPHardeningConfig> = {}
  ) {
    this.config = { ...DEFAULT_MCP_HARDENING_CONFIG, ...config };

    // Initialize circuit breaker
    this.circuitBreaker = CircuitBreakerRegistry.getInstance().get(`mcp-${toolName}`, {
      failureThreshold: this.config.circuitBreaker.failureThreshold,
      successThreshold: this.config.circuitBreaker.successThreshold,
      openDurationMs: this.config.circuitBreaker.openDurationMs,
    });

    // Get timeout for this tool
    this.timeoutMs = this.config.toolTimeouts[toolName] ?? this.config.defaultTimeoutMs;
  }

  /**
   * Execute the tool with hardening
   */
  async execute(args: Record<string, unknown>, context: MCPContext): Promise<ToolResult> {
    const startTime = Date.now();

    // Check circuit breaker
    if (this.config.circuitBreakerEnabled) {
      const state = this.circuitBreaker.getState();
      if (state === "open") {
        const reopenTime = this.circuitBreaker.getReopenTime();
        logger.warn(`Circuit breaker open for ${this.toolName}`, {
          reopenAt: reopenTime?.toISOString(),
        });
        return {
          success: false,
          error: {
            code: "CIRCUIT_OPEN",
            message: `Tool ${this.toolName} is temporarily unavailable due to repeated failures. Will retry after ${reopenTime?.toISOString() ?? "unknown"}`,
          },
        };
      }
    }

    // Set up watchdog if enabled
    let watchdog: Watchdog | undefined;
    let timedOut = false;

    if (this.config.watchdogEnabled) {
      watchdog = new Watchdog(`mcp-${this.toolName}`, {
        timeoutMs: this.timeoutMs,
        onTimeout: (ctx: WatchdogContext): void => {
          timedOut = true;
          logger.error(`Watchdog timeout for ${this.toolName}`, {
            elapsedMs: ctx.startedAt ? Date.now() - ctx.startedAt.getTime() : 0,
            timeoutMs: this.timeoutMs,
          });
        },
      });
      watchdog.start({ toolName: this.toolName, args });
    }

    try {
      // Execute with circuit breaker
      const executeWithTimeout = async (): Promise<ToolResult> => {
        return Promise.race([
          this.handler(args, context),
          new Promise<ToolResult>((_, reject) => {
            setTimeout(() => {
              reject(new Error(`Tool ${this.toolName} timed out after ${this.timeoutMs}ms`));
            }, this.timeoutMs);
          }),
        ]);
      };

      let result: ToolResult;

      if (this.config.circuitBreakerEnabled) {
        result = await this.circuitBreaker.execute(executeWithTimeout);
      } else {
        result = await executeWithTimeout();
      }

      const executionTimeMs = Date.now() - startTime;

      logger.debug(`Tool ${this.toolName} completed`, {
        success: result.success,
        executionTimeMs,
        circuitState: this.circuitBreaker.getState(),
      });

      return result;
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      logger.error(`Tool ${this.toolName} failed`, {
        error: message,
        executionTimeMs,
        timedOut,
        circuitState: this.circuitBreaker.getState(),
      });

      // Check if this was a timeout
      if (message.includes("timed out") || timedOut) {
        return {
          success: false,
          error: {
            code: "TIMEOUT",
            message: `Tool ${this.toolName} timed out after ${this.timeoutMs}ms`,
          },
        };
      }

      // Check if this was a circuit breaker error
      if (message.includes("circuit") || message.includes("Circuit")) {
        return {
          success: false,
          error: {
            code: "CIRCUIT_OPEN",
            message,
          },
        };
      }

      return {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message,
        },
      };
    } finally {
      if (watchdog) {
        watchdog.stop();
      }
    }
  }

  /**
   * Get the circuit breaker state
   */
  getCircuitState(): CircuitState {
    return this.circuitBreaker.getState();
  }

  /**
   * Reset the circuit breaker
   */
  resetCircuit(): void {
    this.circuitBreaker.reset();
  }
}

/**
 * Create a hardened version of a tool handler
 */
export function hardenToolHandler(
  toolName: string,
  handler: ToolHandler,
  config?: Partial<MCPHardeningConfig>
): ToolHandler {
  const hardened = new HardenedToolHandler(toolName, handler, config);
  return (args: Record<string, unknown>, context: MCPContext) => hardened.execute(args, context);
}

/**
 * Get circuit breaker status for all MCP tools
 */
export function getMCPCircuitStatus(): Record<
  string,
  { state: CircuitState; failures: number; reopenAt: string | undefined }
> {
  const registry = CircuitBreakerRegistry.getInstance();
  const allBreakers = registry.getAll();

  const status: Record<
    string,
    { state: CircuitState; failures: number; reopenAt: string | undefined }
  > = {};

  for (const [type, breaker] of allBreakers) {
    // Only include MCP-related circuit breakers
    if (type.startsWith("mcp-")) {
      const reopenTime = breaker.getReopenTime();
      status[type] = {
        state: breaker.getState(),
        failures: breaker.getFailureCount(),
        reopenAt: reopenTime?.toISOString(),
      };
    }
  }

  return status;
}

/**
 * Reset all MCP circuit breakers
 */
export function resetAllMCPCircuits(): void {
  const registry = CircuitBreakerRegistry.getInstance();
  const allBreakers = registry.getAll();

  for (const [type, breaker] of allBreakers) {
    if (type.startsWith("mcp-")) {
      breaker.reset();
      logger.info(`Reset circuit breaker for ${type}`);
    }
  }
}

/**
 * Check if MCP operations are healthy (no open circuits)
 */
export function isMCPHealthy(): boolean {
  const status = getMCPCircuitStatus();
  return Object.values(status).every((s) => s.state !== "open");
}
