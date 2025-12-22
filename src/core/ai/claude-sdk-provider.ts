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
 * Session cache entry for SDK session reuse
 * Caches session IDs by worktree path to allow resuming sessions
 * and potentially reducing re-indexing time.
 */
interface SessionCacheEntry {
  sessionId: string;
  createdAt: Date;
  lastUsedAt: Date;
  queryCount: number;
}

/** Default TTL for cached sessions (30 minutes) */
const SESSION_CACHE_TTL_MS = 30 * 60 * 1000;

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
    customMcpServers: true, // SDK runs in-process, supports custom MCP servers
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

  /**
   * Session cache: maps worktree/cwd paths to session IDs
   * This allows resuming sessions when working on the same codebase,
   * potentially reducing re-indexing time.
   */
  private sessionCache: Map<string, SessionCacheEntry> = new Map();

  /** TTL for cached sessions */
  private sessionCacheTtlMs: number = SESSION_CACHE_TTL_MS;

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
        // Determine allowed tools
        const defaultTools = [
          "Read",
          "Write",
          "Edit",
          "Bash",
          "Glob",
          "Grep",
          "WebFetch",
          "WebSearch",
        ];
        const allowedTools = options.allowedTools ?? defaultTools;

        // Check for cached session to potentially resume
        const cachedSessionId = options.cwd ? this.getCachedSession(options.cwd) : undefined;
        if (cachedSessionId) {
          logger.debug(`Found cached session for ${options.cwd}: ${cachedSessionId}`);
        }

        // Build SDK options
        type SdkOptions = NonNullable<Parameters<typeof sdkQuery>[0]["options"]>;
        const model = options.model ?? this.config.model;
        const sdkOptions: SdkOptions = {
          abortController,
          ...(model && { model }),
          allowedTools,
          maxTurns: options.maxTurns ?? this.config.cli.maxTurns,
          cwd: options.cwd,
          permissionMode: "bypassPermissions",
        };

        // Add session resume if we have a cached session
        if (cachedSessionId) {
          sdkOptions.resume = cachedSessionId;
          logger.debug(`Resuming session: ${cachedSessionId}`);
        }

        // Add MCP servers if provided
        if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
          sdkOptions.mcpServers = options.mcpServers;
        }

        // Execute the SDK query
        const response = sdkQuery({
          prompt: fullPrompt,
          options: sdkOptions,
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

          // Cache the session ID for future queries in the same cwd
          if (options.cwd && isSuccess) {
            this.cacheSession(options.cwd, sessionId);
          }
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

  /**
   * Get a cached session ID for a given working directory
   * Returns undefined if no valid cached session exists
   */
  getCachedSession(cwd: string): string | undefined {
    const entry = this.sessionCache.get(cwd);
    if (!entry) {
      return undefined;
    }

    // Check if session has expired
    const now = Date.now();
    if (now - entry.lastUsedAt.getTime() > this.sessionCacheTtlMs) {
      logger.debug(`Session cache expired for ${cwd}`);
      this.sessionCache.delete(cwd);
      return undefined;
    }

    return entry.sessionId;
  }

  /**
   * Cache a session ID for a given working directory
   */
  cacheSession(cwd: string, sessionId: string): void {
    const existing = this.sessionCache.get(cwd);
    if (existing) {
      // Update existing entry
      existing.sessionId = sessionId;
      existing.lastUsedAt = new Date();
      existing.queryCount++;
      logger.debug(`Updated cached session for ${cwd} (queries: ${existing.queryCount})`);
    } else {
      // Create new entry
      this.sessionCache.set(cwd, {
        sessionId,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        queryCount: 1,
      });
      logger.debug(`Cached new session for ${cwd}`);
    }
  }

  /**
   * Clear the session cache (for testing or cleanup)
   */
  clearSessionCache(): void {
    const count = this.sessionCache.size;
    this.sessionCache.clear();
    logger.debug(`Cleared ${count} cached sessions`);
  }

  /**
   * Get session cache statistics (for testing/monitoring)
   */
  getSessionCacheStats(): {
    size: number;
    entries: Array<{ cwd: string; queryCount: number; ageMs: number }>;
  } {
    const now = Date.now();
    const entries: Array<{ cwd: string; queryCount: number; ageMs: number }> = [];

    for (const [cwd, entry] of this.sessionCache.entries()) {
      entries.push({
        cwd,
        queryCount: entry.queryCount,
        ageMs: now - entry.createdAt.getTime(),
      });
    }

    return {
      size: this.sessionCache.size,
      entries,
    };
  }

  /**
   * Set the session cache TTL (for testing)
   */
  setSessionCacheTtl(ttlMs: number): void {
    this.sessionCacheTtlMs = ttlMs;
  }
}
