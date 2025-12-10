import { AIProvider, QueryResult, ProviderCapabilities, ProviderUsage } from "./types.js";
import { logger } from "../../infra/logger.js";
import { AIProviderError } from "../../infra/errors.js";
import { AIConfig } from "../../types/config.js";

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

  constructor(
    private config: AIConfig,
    dataDir: string
  ) {
    // Store for future SDK implementation
    this.dataDir = dataDir;
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

  async query(_prompt: string, _options: QueryOptions): Promise<QueryResult> {
    const startTime = Date.now();

    // Check for API key
    const apiKey = this.config.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new AIProviderError(
        "ANTHROPIC_API_KEY is required for SDK mode. " +
          "Set it in environment or config, or use executionMode: 'cli' for local development."
      );
    }

    // TODO: Implement actual SDK integration using @anthropic-ai/claude-code
    // This is a placeholder that will be implemented when SDK mode is needed
    //
    // The implementation would look something like:
    //
    // import { query as sdkQuery } from "@anthropic-ai/claude-code";
    //
    // const result = await sdkQuery({
    //   prompt,
    //   options: {
    //     model: options.model ?? this.config.model,
    //     allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    //     maxTurns: options.maxTurns,
    //     maxBudgetUsd: options.maxBudgetUsd ?? this.config.budget?.perIssueLimitUsd,
    //     permissionMode: "acceptEdits",
    //     cwd: options.cwd,
    //   }
    // });

    const durationMs = Date.now() - startTime;

    logger.warn("Claude SDK provider is not yet implemented. Use CLI mode for now.");

    return {
      success: false,
      output: "",
      error:
        "SDK provider not implemented. Use executionMode: 'cli' in config, " +
        "or set ai.executionMode to 'cli' via: oss-agent config set ai.executionMode cli",
      turns: 0,
      durationMs,
    };
  }

  getUsage(): ProviderUsage {
    return { ...this.usage };
  }
}
