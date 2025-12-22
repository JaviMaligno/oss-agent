import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  AIProvider,
  QueryOptions,
  QueryResult,
  ProviderCapabilities,
  ProviderUsage,
} from "./types.js";
import { logger } from "../../infra/logger.js";
import { AIConfig, HardeningConfig } from "../../types/config.js";
import { retryWithRateLimit } from "../../infra/retry.js";
import { getCircuitBreaker, CIRCUIT_OPERATIONS } from "../../infra/circuit-breaker.js";
import { Watchdog } from "../../infra/watchdog.js";
import { registerProcessCleanup, CleanupManager } from "../../infra/cleanup-manager.js";
import { TimeoutError } from "../../infra/errors.js";

export class ClaudeCLIProvider implements AIProvider {
  readonly name = "claude-cli";

  readonly capabilities: ProviderCapabilities = {
    costTracking: false, // CLI doesn't report costs in output
    sessionResume: true, // Can use --resume
    streaming: true, // Output streams to terminal
    budgetLimits: false, // No budget control in CLI mode
    customMcpServers: false, // CLI spawns external process, can't use in-memory MCP servers
  };

  private usage: ProviderUsage = {
    totalQueries: 0,
    totalCostUsd: 0,
    totalTurns: 0,
    queriesToday: 0,
    costTodayUsd: 0,
  };

  private logDir: string;
  private hardeningConfig: HardeningConfig | undefined;

  constructor(
    private config: AIConfig,
    dataDir: string,
    hardeningConfig?: HardeningConfig
  ) {
    this.logDir = join(dataDir, "logs", "claude-sessions");
    this.hardeningConfig = hardeningConfig;
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  async isAvailable(): Promise<boolean> {
    const cliPath = this.config.cli.path;

    return new Promise((resolve) => {
      const proc = spawn(cliPath, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      proc.stdout.on("data", (data: Buffer) => {
        output += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0 && output.toLowerCase().includes("claude")) {
          logger.debug(`Claude CLI found: ${output.trim()}`);
          resolve(true);
        } else {
          logger.warn(`Claude CLI not available at ${cliPath}`);
          resolve(false);
        }
      });

      proc.on("error", () => {
        resolve(false);
      });
    });
  }

  async query(prompt: string, options: QueryOptions): Promise<QueryResult> {
    // CLI mode doesn't support custom MCP servers (they require in-process execution)
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      logger.warn(
        "Custom MCP servers are not supported in CLI mode. " +
          "Switch to SDK mode (ai.executionMode: 'sdk') for tool-based operations."
      );
      // Continue anyway - the prompt will guide the AI but tool calls won't work
    }

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
          logger.warn(`AI query retry ${attempt}: ${error.message}, waiting ${delayMs}ms`);
        },
        shouldRetry: (error) => {
          // Retry on timeout errors and transient failures
          if (error instanceof TimeoutError) return true;
          if (error.message.includes("timed out")) return true;
          if (error.message.includes("ECONNRESET")) return true;
          if (error.message.includes("spawn")) return true;
          return false;
        },
      })
    );
  }

  private executeQuery(prompt: string, options: QueryOptions): Promise<QueryResult> {
    const startTime = Date.now();
    const sessionLogFile = join(
      this.logDir,
      `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`
    );

    const args = this.buildArgs(prompt, options);
    const timeoutMs =
      options.timeoutMs ?? this.hardeningConfig?.watchdog.aiOperationTimeoutMs ?? 900000;

    // Inform user that initialization may take time
    logger.info("Starting Claude Code (may take time to index large repositories)...");
    logger.debug("Spawning Claude CLI", { args: args.join(" "), cwd: options.cwd });

    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      let cleanupTaskId: string | undefined;
      let watchdog: Watchdog | undefined;
      let isTimedOut = false;
      let firstOutputReceived = false;
      let earlyWarningTimer: ReturnType<typeof setTimeout> | undefined;

      try {
        proc = spawn(this.config.cli.path, args, {
          cwd: options.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            // Ensure CLI doesn't try to use interactive features
            TERM: "dumb",
            CI: "true",
          },
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        reject(new Error(`Failed to spawn Claude CLI: ${errorMsg}`));
        return;
      }

      // Register process for cleanup on shutdown
      if (proc.pid) {
        cleanupTaskId = registerProcessCleanup(proc.pid);
      }

      // Set up early warning for users if no output after 30 seconds
      earlyWarningTimer = setTimeout(() => {
        if (!firstOutputReceived) {
          logger.warn("Claude Code is still initializing (indexing repository)...");
          logger.info("This is normal for large repositories. Please wait...");
        }
      }, 30000);

      // Set up periodic status updates every 60 seconds while waiting
      const statusTimer = setInterval(() => {
        if (!firstOutputReceived) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          logger.info(`Still waiting for Claude Code (${elapsed}s elapsed)...`);
        }
      }, 60000);

      // Set up watchdog for hung detection
      watchdog = new Watchdog("claude-cli-query", {
        timeoutMs,
        onTimeout: (ctx) => {
          isTimedOut = true;
          clearInterval(statusTimer);
          if (earlyWarningTimer) clearTimeout(earlyWarningTimer);
          logger.warn(`Claude CLI hung after ${ctx.operationType}`, {
            elapsed: Date.now() - ctx.startedAt.getTime(),
          });
          if (!proc.killed) {
            proc.kill("SIGTERM");
            // Force kill after 5 seconds if SIGTERM doesn't work
            setTimeout(() => {
              if (!proc.killed) {
                proc.kill("SIGKILL");
              }
            }, 5000);
          }
        },
      });
      watchdog.start({ prompt: prompt.slice(0, 100) });

      let stdout = "";
      let stderr = "";
      let sessionId: string | undefined;
      let turns = 0;

      // Write prompt to stdin and close
      proc.stdin?.write(prompt);
      proc.stdin?.end();

      // Helper to handle first output
      const onFirstOutput = (): void => {
        if (!firstOutputReceived) {
          firstOutputReceived = true;
          if (earlyWarningTimer) clearTimeout(earlyWarningTimer);
          clearInterval(statusTimer);
          logger.info("Claude Code started processing...");
        }
      };

      proc.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;

        // Mark first output and clear warning timers
        onFirstOutput();

        // Heartbeat on output
        watchdog?.heartbeat();

        // Log to file in real-time
        this.appendToLog(sessionLogFile, `[STDOUT] ${chunk}`);

        // Try to extract session ID from output
        const sessionMatch = chunk.match(/session[:\s]+([a-zA-Z0-9-]+)/i);
        if (sessionMatch?.[1]) {
          sessionId = sessionMatch[1];
        }

        // Count turns (rough estimate based on assistant responses)
        if (chunk.includes("Assistant:") || chunk.includes("Claude:")) {
          turns++;
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;

        // Mark first output and clear warning timers
        onFirstOutput();

        // Heartbeat on output
        watchdog?.heartbeat();

        this.appendToLog(sessionLogFile, `[STDERR] ${chunk}`);

        // Log progress to console (summarized)
        if (chunk.includes("Tool:") || chunk.includes("Reading") || chunk.includes("Writing")) {
          const line = chunk.split("\n")[0];
          if (line) {
            logger.debug(line.trim());
          }
        }
      });

      proc.on("close", (code) => {
        const durationMs = Date.now() - startTime;

        // Stop watchdog and cleanup
        watchdog?.stop();
        if (cleanupTaskId) {
          CleanupManager.getInstance().unregister(cleanupTaskId);
        }

        // Update usage stats
        this.usage.totalQueries++;
        this.usage.queriesToday++;
        this.usage.totalTurns += turns;

        // Log summary
        this.appendToLog(
          sessionLogFile,
          `\n--- Session Complete ---\nExit code: ${code}\nDuration: ${durationMs}ms\nTurns: ${turns}\n`
        );

        if (isTimedOut) {
          reject(
            new TimeoutError(
              `Claude CLI timed out after ${timeoutMs}ms`,
              "claude-cli-query",
              timeoutMs
            )
          );
          return;
        }

        if (code === 0) {
          logger.success(`Claude CLI completed in ${(durationMs / 1000).toFixed(1)}s`);
          logger.info(`Session log: ${sessionLogFile}`);

          const result: QueryResult = {
            success: true,
            output: this.extractFinalOutput(stdout),
            turns,
            durationMs,
            rawOutput: stdout,
          };
          if (sessionId !== undefined) {
            result.sessionId = sessionId;
          }
          resolve(result);
        } else {
          const errorMsg = stderr || `Claude CLI exited with code ${code}`;
          logger.error(`Claude CLI failed: ${errorMsg}`);

          resolve({
            success: false,
            output: "",
            error: errorMsg,
            turns,
            durationMs,
            rawOutput: stdout + "\n" + stderr,
          });
        }
      });

      proc.on("error", (err) => {
        const durationMs = Date.now() - startTime;

        // Stop watchdog and cleanup
        watchdog?.stop();
        if (cleanupTaskId) {
          CleanupManager.getInstance().unregister(cleanupTaskId);
        }

        logger.error(`Failed to spawn Claude CLI: ${err.message}`);

        resolve({
          success: false,
          output: "",
          error: `Failed to spawn Claude CLI: ${err.message}`,
          turns: 0,
          durationMs,
        });
      });
    });
  }

  getUsage(): ProviderUsage {
    return { ...this.usage };
  }

  private buildArgs(_prompt: string, options: QueryOptions): string[] {
    const args: string[] = [];

    // Resume from previous session if provided
    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
      logger.debug(`Resuming session: ${options.resumeSessionId}`);
    }

    // Print mode (non-interactive, outputs result)
    args.push("--print");

    // Auto-approve if configured
    if (this.config.cli.autoApprove) {
      args.push("--dangerously-skip-permissions");
    }

    // Output format for easier parsing
    args.push("--output-format", "text");

    // Max turns
    if (options.maxTurns ?? this.config.cli.maxTurns) {
      args.push("--max-turns", String(options.maxTurns ?? this.config.cli.maxTurns));
    }

    // Model selection (if supported)
    const model = options.model ?? this.config.model;
    if (model) {
      args.push("--model", model);
    }

    // The prompt is passed via stdin, but we can also use -p for simple prompts
    // Using stdin allows for larger prompts with special characters
    args.push("--");

    return args;
  }

  private extractFinalOutput(stdout: string): string {
    // Try to extract the final assistant response
    // The output format varies, so we try multiple patterns

    // Pattern 1: Look for last "Assistant:" or similar block
    const lines = stdout.split("\n");
    let inAssistantBlock = false;
    let output: string[] = [];

    for (const line of lines) {
      if (
        line.startsWith("Assistant:") ||
        line.startsWith("Claude:") ||
        line.includes("Response:")
      ) {
        inAssistantBlock = true;
        output = [];
        continue;
      }
      if (inAssistantBlock) {
        if (line.startsWith("User:") || line.startsWith("Tool:") || line.startsWith("---")) {
          inAssistantBlock = false;
        } else {
          output.push(line);
        }
      }
    }

    if (output.length > 0) {
      return output.join("\n").trim();
    }

    // Fallback: return last non-empty chunk of output
    const chunks = stdout.split(/\n\n+/);
    for (let i = chunks.length - 1; i >= 0; i--) {
      const chunk = chunks[i]?.trim();
      if (chunk && chunk.length > 10) {
        return chunk;
      }
    }

    return stdout.trim();
  }

  private appendToLog(file: string, content: string): void {
    try {
      writeFileSync(file, content, { flag: "a" });
    } catch {
      // Ignore log write errors
    }
  }
}
