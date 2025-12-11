import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { GitOperations } from "../../core/git/git-operations.js";
import { WorktreeManager } from "../../core/git/worktree-manager.js";
import { ParallelOrchestrator, ParallelStatus } from "../../core/engine/parallel-orchestrator.js";
import { createProvider } from "../../core/ai/provider-factory.js";

export function createWorkParallelCommand(): Command {
  const command = new Command("work-parallel")
    .description("Work on multiple GitHub issues in parallel")
    .argument("<issue-urls...>", "GitHub issue URLs to work on")
    .option("-c, --count <n>", "Maximum concurrent agents", parseInt)
    .option("-b, --max-budget <usd>", "Total budget for all issues in USD", parseFloat)
    .option("--skip-pr", "Skip creating pull requests", false)
    .option("--no-conflict-check", "Skip file conflict detection")
    .option("-v, --verbose", "Enable verbose output", false)
    .action(async (issueUrls: string[], options: WorkParallelOptions) => {
      if (options.verbose) {
        logger.configure({ level: "debug", verbose: true });
      }

      try {
        await runWorkParallel(issueUrls, options);
      } catch (error) {
        logger.error("Parallel work failed", error);
        process.exit(1);
      }
    });

  return command;
}

interface WorkParallelOptions {
  count?: number;
  maxBudget?: number;
  skipPr: boolean;
  conflictCheck: boolean;
  verbose: boolean;
}

async function runWorkParallel(issueUrls: string[], options: WorkParallelOptions): Promise<void> {
  logger.header("OSS Agent - Parallel Work");

  // Load configuration
  const config = loadConfig();
  const dataDir = expandPath(config.dataDir);

  // Validate issue URLs
  const invalidUrls = issueUrls.filter(
    (url) => !url.includes("github.com") || !url.includes("/issues/")
  );
  if (invalidUrls.length > 0) {
    logger.error("Invalid issue URLs:");
    for (const url of invalidUrls) {
      console.error(`  ${pc.red("✗")} ${url}`);
    }
    console.error("");
    console.error(pc.dim("Expected format: https://github.com/owner/repo/issues/123"));
    process.exit(1);
  }

  const maxConcurrent = options.count ?? config.parallel.maxConcurrentAgents;

  logger.info(`Issues: ${pc.cyan(String(issueUrls.length))}`);
  logger.info(`Max concurrent: ${pc.yellow(String(maxConcurrent))}`);
  if (options.maxBudget) {
    logger.info(`Total budget: $${options.maxBudget}`);
  }
  if (options.skipPr) {
    logger.warn("PR creation disabled");
  }
  console.error("");

  // Initialize components
  const stateManager = new StateManager(dataDir);
  const gitOps = new GitOperations(config.git, dataDir);
  const worktreeManager = new WorktreeManager(gitOps, config.parallel);
  const aiProvider = await createProvider(config);

  // Check AI provider availability
  const available = await aiProvider.isAvailable();
  if (!available) {
    logger.error(`AI provider '${aiProvider.name}' is not available.`);
    if (config.ai.executionMode === "sdk") {
      logger.info("Hint: Set ANTHROPIC_API_KEY or switch to CLI mode:");
      logger.info("  oss-agent config set ai.executionMode cli");
    } else {
      logger.info("Hint: Ensure 'claude' CLI is installed and authenticated");
    }
    stateManager.close();
    process.exit(1);
  }

  logger.info(`AI Provider: ${pc.green(aiProvider.name)}`);
  console.error("");

  // Create orchestrator
  const orchestrator = new ParallelOrchestrator(
    config,
    stateManager,
    gitOps,
    worktreeManager,
    aiProvider
  );

  // Handle SIGINT for graceful cancellation
  process.on("SIGINT", () => {
    console.error("");
    logger.warn("Received SIGINT, cancelling all work...");
    orchestrator.cancelAllWork();
  });

  try {
    const processOptions: Parameters<typeof orchestrator.processIssues>[0] = {
      issueUrls,
      maxConcurrent,
      skipConflictCheck: !options.conflictCheck,
      onProgress: (status) => displayProgress(status),
    };
    if (options.maxBudget !== undefined) {
      processOptions.maxBudgetUsd = options.maxBudget;
    }
    if (options.skipPr) {
      processOptions.skipPR = true;
    }
    const result = await orchestrator.processIssues(processOptions);

    console.error("");
    logger.header("Results");

    // Display individual results
    for (const item of result.results) {
      if (item.result?.success) {
        console.error(`${pc.green("✓")} ${item.issueUrl}`);
        if (item.result.prUrl) {
          console.error(`  ${pc.dim("PR:")} ${item.result.prUrl}`);
        }
      } else if (item.error === "Cancelled") {
        console.error(`${pc.yellow("○")} ${item.issueUrl} ${pc.dim("(cancelled)")}`);
      } else {
        console.error(`${pc.red("✗")} ${item.issueUrl}`);
        console.error(`  ${pc.dim("Error:")} ${item.error ?? item.result?.error ?? "Unknown"}`);
      }
    }

    console.error("");
    console.error(pc.dim("Summary:"));
    console.error(`  Total: ${result.summary.total}`);
    console.error(`  Successful: ${pc.green(String(result.summary.successful))}`);
    console.error(
      `  Failed: ${result.summary.failed > 0 ? pc.red(String(result.summary.failed)) : "0"}`
    );
    console.error(
      `  Cancelled: ${result.summary.cancelled > 0 ? pc.yellow(String(result.summary.cancelled)) : "0"}`
    );
    console.error(`  Total cost: $${result.summary.totalCostUsd.toFixed(4)}`);
    console.error(`  Duration: ${(result.summary.totalDurationMs / 1000).toFixed(1)}s`);

    if (!result.success) {
      stateManager.close();
      process.exit(1);
    }
  } finally {
    stateManager.close();
  }
}

function displayProgress(status: ParallelStatus): void {
  // Clear line and display progress
  const total = status.total;
  const done = status.completed + status.failed + status.cancelled;
  const progress = `[${done}/${total}]`;

  const parts = [
    `${pc.dim(progress)}`,
    status.inProgress > 0 ? pc.cyan(`${status.inProgress} working`) : null,
    status.completed > 0 ? pc.green(`${status.completed} done`) : null,
    status.failed > 0 ? pc.red(`${status.failed} failed`) : null,
    status.cancelled > 0 ? pc.yellow(`${status.cancelled} cancelled`) : null,
    status.pending > 0 ? pc.dim(`${status.pending} pending`) : null,
  ].filter(Boolean);

  // Use stderr to not interfere with stdout
  process.stderr.write(`\r${parts.join(" | ")}${" ".repeat(20)}`);

  // When all done, move to next line
  if (done === total) {
    console.error("");
  }
}
