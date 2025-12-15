import { AIProvider, QueryResult, ProviderCapabilities, ProviderUsage } from "./types.js";
import { logger } from "../../infra/logger.js";
import { AIProviderError, TimeoutError } from "../../infra/errors.js";
import { AIConfig, HardeningConfig } from "../../types/config.js";
import { query as sdkQuery, type SDKResultMessage } from "@anthropic-ai/claude-code";
import { retryWithRateLimit } from "../../infra/retry.js";
import { getCircuitBreaker, CIRCUIT_OPERATIONS } from "../../infra/circuit-breaker.js";
import { Watchdog } from "../../infra/watchdog.js";

import type { QueryOptions } from "./types.js";

/**
 * Claude SDK Provider - Uses Anthropic API directly
 *
 * This provider requires ANTHROPIC_API_KEY to be set.
 * It's intended for production/deployed scenarios where you want
 * programmatic control and cost tracking.
 *
 * For local development, prefer ClaudeCLIProvider which uses your
 * existing claude CLI authentication.
 */
export class ClaudeSDKProvider implements AIProvider {
  readonly name = "claude-sdk";

  readonly capabilities: ProviderCapabilities = {
    costTracking: true,
    sessionResume: true,
    streaming: true,
    budgetLimits: true,
  };

  private usage: ProviderUsage = {
    totalQueries: 0,
    totalCostUsd: 0,
    totalTurns: 0,
    queriesToday: 0,
    costTodayUsd: 0,
  };

  private dataDir: string;
  private hardeningConfig: HardeningConfig | undefined;

  constructor(
    private config: AIConfig,
    dataDir: string,
    hardeningConfig?: HardeningConfig
  ) {
    // Store for future SDK implementation
    this.dataDir = dataDir;
    this.hardeningConfig = hardeningConfig;
  }

  /** Get the data directory (used for session storage in SDK mode) */
  getDataDir(): string {
    return this.dataDir;
  }

  async isAvailable(): Promise<boolean> {
    const apiKey = this.config.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      logger.debug("Claude SDK not available: ANTHROPIC_API_KEY not set");
      return false;
    }

    // TODO: Optionally verify API key with a test call
    return true;
  }

  async query(prompt: string, options: QueryOptions): Promise<QueryResult> {
    const cbConfig = this.hardeningConfig?.circuitBreaker;
    const circuitBreaker = getCircuitBreaker(
      CIRCUIT_OPERATIONS.AI_PROVIDER,
      cbConfig
        ? {
            failureThreshold: cbConfig.failureThreshold,
            successThreshold: cbConfig.successThreshold,
            openDurationMs: cbConfig.openDurationMs,
          }
        : undefined
    );

    const retryConfig = this.hardeningConfig?.retry;

    // Execute with circuit breaker and retry
    return circuitBreaker.execute(() =>
      retryWithRateLimit(() => this.executeQuery(prompt, options), {
        maxRetries: retryConfig?.maxRetries ?? 2,
        baseDelayMs: retryConfig?.baseDelayMs ?? 2000,
        maxDelayMs: retryConfig?.maxDelayMs ?? 30000,
        jitter: retryConfig?.enableJitter ?? true,
        onRetry: (error, attempt, delayMs) => {
          logger.warn(`SDK query retry ${attempt}: ${error.message}, waiting ${delayMs}ms`);
        },
        shouldRetry: (error) => {
          // Retry on timeout errors and transient failures
          if (error instanceof TimeoutError) return true;
          if (error.name === "AbortError") return true;
          if (error.message.includes("timed out")) return true;
          if (error.message.includes("ECONNRESET")) return true;
          if (error.message.includes("rate limit")) return true;
          return false;
        },
      })
    );
  }

  private async executeQuery(prompt: string, options: QueryOptions): Promise<QueryResult> {
    const startTime = Date.now();
    const timeoutMs =
      options.timeoutMs ?? this.hardeningConfig?.watchdog.aiOperationTimeoutMs ?? 300000;

    // Check for API key
    const apiKey = this.config.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new AIProviderError(
        "ANTHROPIC_API_KEY is required for SDK mode. " +
          "Set it in environment or config, or use executionMode: 'cli' for local development."
      );
    }

    // Set up watchdog for hung detection
    const watchdog = new Watchdog("claude-sdk-query", {
      timeoutMs,
      onTimeout: (ctx) => {
        logger.warn(`SDK query watchdog timeout`, {
          elapsed: Date.now() - ctx.startedAt.getTime(),
        });
      },
    });

    try {
      // Build the full prompt with system context if provided
      const fullPrompt = options.systemContext ? `${options.systemContext}\n\n${prompt}` : prompt;

      logger.debug(`SDK query starting in ${options.cwd}`);

      // Create abort controller for timeout handling
      const abortController = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      timeoutId = setTimeout(() => {
        abortController.abort();
      }, timeoutMs);

      watchdog.start({ prompt: prompt.slice(0, 100) });

      try {
        // Execute the SDK query
        const response = sdkQuery({
          prompt: fullPrompt,
          options: {
            abortController,
            model: options.model ?? this.config.model,
            allowedTools: [
              "Read",
              "Write",
              "Edit",
              "Bash",
              "Glob",
              "Grep",
              "WebFetch",
              "WebSearch",
            ],
            maxTurns: options.maxTurns ?? this.config.cli.maxTurns,
            cwd: options.cwd,
            permissionMode: "bypassPermissions",
            // Note: SDK handles API key from environment automatically
          },
        });

        let resultMessage: SDKResultMessage | null = null;
        let sessionId: string | undefined;

        // Iterate through all messages to get the final result
        for await (const message of response) {
          // Heartbeat on each message
          watchdog.heartbeat();

          // Track session ID from any message
          if ("session_id" in message && message.session_id) {
            sessionId = message.session_id;
          }

          // Capture the result message
          if (message.type === "result") {
            resultMessage = message as SDKResultMessage;
          }

          // Log progress for debugging
          if (message.type === "assistant") {
            logger.debug("SDK: Assistant message received");
          }
        }

        // Clear timeout if set
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        const durationMs = Date.now() - startTime;

        if (!resultMessage) {
          return {
            success: false,
            output: "",
            error: "No result message received from SDK",
            turns: 0,
            durationMs,
          };
        }

        // Update usage statistics
        this.updateUsage(resultMessage.num_turns, resultMessage.total_cost_usd);

        // Check if it was successful
        const isSuccess = resultMessage.subtype === "success" && !resultMessage.is_error;

        const result: QueryResult = {
          success: isSuccess,
          output: isSuccess && "result" in resultMessage ? resultMessage.result : "",
          costUsd: resultMessage.total_cost_usd,
          turns: resultMessage.num_turns,
          durationMs,
        };

        // Only add optional properties if they have values
        if (sessionId) {
          result.sessionId = sessionId;
        }
        if (!isSuccess) {
          result.error = `SDK execution failed: ${resultMessage.subtype}`;
        }

        return result;
      } finally {
        // Ensure timeout is cleared
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        watchdog.stop();
      }
    } catch (error) {
      const durationMs = Date.now() - startTime;
      watchdog.stop();

      // Handle abort/timeout
      if (error instanceof Error && error.name === "AbortError") {
        throw new TimeoutError(
          `SDK query timed out after ${timeoutMs}ms`,
          "claude-sdk-query",
          timeoutMs
        );
      }

      // Handle other errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`SDK query failed: ${errorMessage}`);

      return {
        success: false,
        output: "",
        error: errorMessage,
        turns: 0,
        durationMs,
      };
    }
  }

  private updateUsage(turns: number, costUsd: number): void {
    this.usage.totalQueries++;
    this.usage.queriesToday++;
    this.usage.totalTurns += turns;
    this.usage.totalCostUsd += costUsd;
    this.usage.costTodayUsd += costUsd;
  }

  getUsage(): ProviderUsage {
    return { ...this.usage };
  }
}
