/**
 * run command - Autonomous mode to work through the issue queue
 */

import { Command } from "commander";
import pc from "picocolors";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { QueueManager } from "../../core/engine/queue-manager.js";
import { RateLimiter } from "../../core/engine/rate-limiter.js";
import { ConflictDetector } from "../../core/engine/conflict-detector.js";
import { IssueProcessor } from "../../core/engine/issue-processor.js";
import { GitOperations } from "../../core/git/git-operations.js";
import {
  AutonomousRunner,
  AutonomousConfig,
  AutonomousStatus,
} from "../../core/engine/autonomous-runner.js";
import { DiscoveryService } from "../../oss/discovery/discovery-service.js";
import { SelectionService } from "../../oss/selection/selection-service.js";
import { createProvider } from "../../core/ai/index.js";
import { logger } from "../../infra/logger.js";

interface RunOptions {
  maxIssues?: string;
  maxHours?: string;
  maxBudget?: string;
  replenish: boolean;
  cooldown: string;
  dryRun: boolean;
  verbose: boolean;
}

export function createRunCommand(): Command {
  return new Command("run")
    .description("Run autonomous mode - work through queue automatically")
    .option("-n, --max-issues <n>", "Maximum issues to process")
    .option("-t, --max-hours <hours>", "Maximum hours to run")
    .option("-b, --max-budget <usd>", "Maximum budget in USD")
    .option("--no-replenish", "Disable automatic queue replenishment")
    .option("--cooldown <ms>", "Cooldown between issues in ms", "5000")
    .option("--dry-run", "Show what would be processed without executing", false)
    .option("-v, --verbose", "Enable verbose output", false)
    .action(async (options: RunOptions) => {
      await runAutonomous(options);
    });
}

async function runAutonomous(options: RunOptions): Promise<void> {
  try {
    const config = loadConfig();
    const dataDir = expandPath(config.dataDir);
    const stateManager = new StateManager(dataDir);

    // Initialize services
    const discoveryService = new DiscoveryService(config.oss);
    const selectionService = new SelectionService(config.oss);
    const queueManager = new QueueManager(stateManager, discoveryService, selectionService, config);
    const rateLimiter = new RateLimiter(
      stateManager,
      config.oss?.qualityGates ?? {
        maxPrsPerProjectPerDay: 2,
        maxPrsPerDay: 10,
        maxFilesChanged: 20,
        maxLinesChanged: 500,
        requireTestsPass: true,
        requireLintPass: true,
      }
    );
    const conflictDetector = new ConflictDetector(stateManager);
    const aiProvider = await createProvider(config);
    const gitOps = new GitOperations(config.git, dataDir);
    const issueProcessor = new IssueProcessor(config, stateManager, gitOps, aiProvider);

    // Create autonomous runner
    const runner = new AutonomousRunner(
      config,
      stateManager,
      queueManager,
      rateLimiter,
      conflictDetector,
      issueProcessor
    );

    // Build config
    const autonomousConfig: AutonomousConfig = {
      cooldownMs: parseInt(options.cooldown, 10),
      autoReplenish: options.replenish,
      dryRun: options.dryRun,
    };
    if (options.maxIssues) {
      autonomousConfig.maxIterations = parseInt(options.maxIssues, 10);
    }
    if (options.maxHours) {
      autonomousConfig.maxDurationHours = parseFloat(options.maxHours);
    }
    if (options.maxBudget) {
      autonomousConfig.maxBudgetUsd = parseFloat(options.maxBudget);
    }

    // Show initial status
    const queueStatus = queueManager.getQueueStatus();
    console.log(pc.bold("\nOSS Agent - Autonomous Mode"));
    console.log(pc.dim("═".repeat(40)));
    console.log();
    console.log(`  ${pc.dim("Queue size:")}    ${queueStatus.size} issues`);
    console.log(`  ${pc.dim("Max issues:")}    ${autonomousConfig.maxIterations ?? "unlimited"}`);
    console.log(
      `  ${pc.dim("Max duration:")}  ${autonomousConfig.maxDurationHours ? `${autonomousConfig.maxDurationHours}h` : "unlimited"}`
    );
    console.log(
      `  ${pc.dim("Max budget:")}    ${autonomousConfig.maxBudgetUsd ? `$${autonomousConfig.maxBudgetUsd}` : "unlimited"}`
    );
    console.log(
      `  ${pc.dim("Auto-replenish:")} ${autonomousConfig.autoReplenish ? "enabled" : "disabled"}`
    );
    console.log(`  ${pc.dim("Cooldown:")}      ${autonomousConfig.cooldownMs}ms`);
    if (options.dryRun) {
      console.log(pc.yellow("  [DRY RUN MODE]"));
    }
    console.log();

    if (queueStatus.size === 0 && !autonomousConfig.autoReplenish) {
      console.log(pc.yellow("Queue is empty and auto-replenish is disabled."));
      console.log(pc.dim("Use 'oss-agent queue add <issue-url>' to add issues."));
      stateManager.close();
      return;
    }

    // Set up event handlers
    runner.on("issue:start", (issueUrl: string) => {
      console.log(pc.cyan(`\n▶ Starting: ${issueUrl}`));
    });

    runner.on("issue:complete", (issueUrl: string, prUrl: string) => {
      console.log(pc.green(`✓ Completed: ${issueUrl}`));
      if (prUrl) {
        console.log(pc.dim(`  PR: ${prUrl}`));
      }
    });

    runner.on("issue:failed", (issueUrl: string, error: string) => {
      console.log(pc.red(`✗ Failed: ${issueUrl}`));
      console.log(pc.dim(`  Error: ${error}`));
    });

    runner.on("issue:skipped", (issueUrl: string, reason: string) => {
      console.log(pc.yellow(`○ Skipped: ${issueUrl}`));
      console.log(pc.dim(`  Reason: ${reason}`));
    });

    runner.on("queue:replenished", (added: number) => {
      console.log(pc.blue(`📥 Queue replenished: +${added} issues`));
    });

    runner.on("status:changed", (status: AutonomousStatus) => {
      if (options.verbose) {
        console.log(
          pc.dim(
            `[${status.state}] iteration=${status.iteration} ` +
              `success=${status.processed.success} failed=${status.processed.failed} ` +
              `queue=${status.queueSize} cost=$${status.totalCostUsd.toFixed(2)}`
          )
        );
      }
    });

    // Handle graceful shutdown
    const handleShutdown = (): void => {
      console.log(pc.yellow("\n\nShutting down gracefully..."));
      runner.requestStop();
    };

    process.on("SIGINT", handleShutdown);
    process.on("SIGTERM", handleShutdown);

    // Run
    console.log(pc.dim("Starting autonomous processing..."));
    console.log(pc.dim("Press Ctrl+C to stop gracefully.\n"));

    const result = await runner.run(autonomousConfig);

    // Clean up
    process.off("SIGINT", handleShutdown);
    process.off("SIGTERM", handleShutdown);

    // Show results
    console.log();
    console.log(pc.bold("Results"));
    console.log(pc.dim("─".repeat(40)));
    console.log(`  ${pc.dim("Iterations:")}  ${result.iterations}`);
    console.log(`  ${pc.dim("Duration:")}    ${formatDuration(result.durationMs)}`);
    console.log(
      `  ${pc.dim("Successful:")}  ${pc.green(String(result.processed.filter((p) => p.success).length))}`
    );
    console.log(
      `  ${pc.dim("Failed:")}      ${pc.red(String(result.processed.filter((p) => !p.success).length))}`
    );
    console.log(`  ${pc.dim("Total cost:")}  $${result.totalCostUsd.toFixed(2)}`);
    console.log(`  ${pc.dim("Stop reason:")} ${formatStopReason(result.stopReason)}`);

    if (result.processed.length > 0) {
      console.log();
      console.log(pc.bold("Processed Issues:"));
      for (const item of result.processed) {
        const icon = item.success ? pc.green("✓") : pc.red("✗");
        console.log(`  ${icon} ${item.issueUrl}`);
        if (item.prUrl) {
          console.log(pc.dim(`    → ${item.prUrl}`));
        }
        if (item.error) {
          console.log(pc.dim(`    Error: ${item.error}`));
        }
      }
    }

    stateManager.close();
  } catch (error) {
    logger.error(`Autonomous run failed: ${error}`);
    console.error(pc.red(`\nError: ${error}`));
    process.exit(1);
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatStopReason(reason: string): string {
  const reasonMap: Record<string, string> = {
    completed: pc.green("completed"),
    max_iterations: pc.yellow("max iterations reached"),
    max_duration: pc.yellow("max duration reached"),
    max_budget: pc.yellow("max budget reached"),
    manual_stop: pc.blue("manual stop"),
    error: pc.red("error"),
    empty_queue: pc.dim("empty queue"),
    rate_limited: pc.yellow("rate limited"),
  };
  return reasonMap[reason] ?? reason;
}
