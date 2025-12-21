import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { GitOperations } from "../../core/git/git-operations.js";
import { WorktreeManager } from "../../core/git/worktree-manager.js";
import { ParallelOrchestrator, ParallelStatus } from "../../core/engine/parallel-orchestrator.js";
import { createProvider } from "../../core/ai/provider-factory.js";
import { CleanupManager } from "../../infra/cleanup-manager.js";
import { DiscoveryService } from "../../oss/discovery/index.js";
import { SelectionService } from "../../oss/selection/index.js";
import { PRService, FeedbackParser, PRMonitor } from "../../core/github/index.js";
import { IterationHandler } from "../../core/engine/index.js";

export function createWorkParallelCommand(): Command {
  const command = new Command("work-parallel")
    .description("Work on multiple GitHub issues in parallel")
    .argument("[issue-urls...]", "GitHub issue URLs to work on (optional if using --from)")
    .option("--from <repo>", "Auto-select issues from repository (owner/repo), sorted by ROI")
    .option("-n, --num <n>", "Number of issues to auto-select when using --from", parseInt, 3)
    .option("-c, --count <n>", "Maximum concurrent agents", parseInt)
    .option("-b, --max-budget <usd>", "Total budget for all issues in USD", parseFloat)
    .option("--skip-pr", "Skip creating pull requests", false)
    .option("--no-conflict-check", "Skip file conflict detection")
    .option("--watch", "Continue watching PRs for CI failures after work completes", false)
    .option("--watch-interval <seconds>", "Watch poll interval in seconds", parseInt, 60)
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
  from?: string;
  num: number;
  count?: number;
  maxBudget?: number;
  skipPr: boolean;
  conflictCheck: boolean;
  watch: boolean;
  watchInterval: number;
  verbose: boolean;
}

async function runWorkParallel(issueUrls: string[], options: WorkParallelOptions): Promise<void> {
  // Install shutdown handlers for cleanup
  const cleanupManager = CleanupManager.getInstance();
  cleanupManager.installShutdownHandlers();

  logger.header("OSS Agent - Parallel Work");

  // Load configuration
  const config = loadConfig();
  const dataDir = expandPath(config.dataDir);
  const hardeningConfig = config.hardening;
  const ossConfig = config.oss;

  // Auto-select issues from repo if --from is provided
  if (options.from) {
    logger.info(`Auto-selecting issues from: ${pc.cyan(options.from)}`);
    console.error("");

    const discoveryService = new DiscoveryService(ossConfig);
    const project = await discoveryService.getProjectInfo(options.from);

    if (!project) {
      logger.error(`Could not find repository: ${options.from}`);
      process.exit(1);
    }

    logger.info(`Repository: ${pc.cyan(project.fullName)} (${project.stars} ⭐)`);
    logger.info(`Finding top ${options.num} issues by ROI...`);
    console.error("");

    const selectionService = new SelectionService(ossConfig);
    const issues = await selectionService.findIssues(project, {
      sortBy: "roi",
      limit: options.num,
      requireNoExistingPR: true,
      includeAssigned: false,
    });

    if (issues.length === 0) {
      logger.error("No suitable issues found. Try a different repository or adjust filters.");
      process.exit(1);
    }

    // Display selected issues with their ROI scores
    logger.success(`Selected ${issues.length} issues:`);
    for (const issue of issues) {
      const roi = selectionService.calculateROI(issue, {
        stars: project.stars,
        forks: project.forks,
      });
      console.error(
        `  ${pc.green("→")} #${issue.number}: ${issue.title.substring(0, 50)}${issue.title.length > 50 ? "..." : ""} ${pc.dim(`(ROI: ${roi.roi})`)}`
      );
    }
    console.error("");

    // Replace issueUrls with the discovered ones
    issueUrls = issues.map((issue) => issue.url);
  }

  // Validate issue URLs
  if (issueUrls.length === 0) {
    logger.error(
      "No issue URLs provided. Use --from <repo> to auto-select or provide URLs directly."
    );
    console.error("");
    console.error(pc.dim("Usage:"));
    console.error(pc.dim("  oss-agent work-parallel --from colinhacks/zod -n 3"));
    console.error(pc.dim("  oss-agent work-parallel <issue-url> [issue-url...]"));
    process.exit(1);
  }

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
  const gitOps = new GitOperations(config.git, dataDir, hardeningConfig);
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

    // Collect PR URLs for watching
    const prUrls = result.results
      .filter((item) => item.result?.prUrl)
      .map((item) => item.result!.prUrl!);

    // Start watching PRs for CI failures if enabled
    if (options.watch && prUrls.length > 0 && !options.skipPr) {
      console.error("");
      logger.header("Watch Mode");
      // Ensure watchInterval has a valid value (default to 60s if NaN or undefined)
      const watchIntervalSecs = Number.isFinite(options.watchInterval) ? options.watchInterval : 60;
      logger.info(`Watching ${prUrls.length} PR(s) for CI failures...`);
      logger.info(`Poll interval: ${watchIntervalSecs}s`);
      console.error("");

      await watchPRsForCI(
        prUrls,
        stateManager,
        gitOps,
        aiProvider,
        config,
        watchIntervalSecs * 1000
      );
    }

    if (!result.success) {
      stateManager.close();
      process.exit(1);
    }
  } finally {
    stateManager.close();
  }
}

/**
 * Watch PRs for CI failures and auto-iterate to fix them
 */
async function watchPRsForCI(
  prUrls: string[],
  stateManager: StateManager,
  gitOps: GitOperations,
  aiProvider: Awaited<ReturnType<typeof createProvider>>,
  config: ReturnType<typeof loadConfig>,
  pollIntervalMs: number
): Promise<void> {
  const prService = new PRService();
  const feedbackParser = new FeedbackParser();
  const iterationHandler = new IterationHandler(config, stateManager, gitOps, aiProvider);

  const monitor = new PRMonitor(prService, feedbackParser, {
    pollIntervalMs,
    inactivityTimeoutMins: 60, // 1 hour max watch time
  });

  // Track which PRs have been handled
  const handledPRs = new Set<number>();

  // Set up event handlers
  monitor.on("feedback", async (data) => {
    const { pr, feedback } = data;

    // Skip if already handled or merged/closed
    if (handledPRs.has(pr.number) || pr.state !== "open") {
      return;
    }

    // Check for CI failures
    if (feedback && pr.checksPass === false) {
      logger.warn(`${pc.cyan(`PR #${pr.number}`)}: CI checks failing`);

      const ciItems = feedback.actionableItems.filter((item) => item.type === "ci_failure");
      if (ciItems.length > 0) {
        logger.info(`Found ${ciItems.length} CI failure(s), attempting to fix...`);

        try {
          const result = await iterationHandler.iterate({
            prUrl: pr.url,
            maxBudgetUsd: 2,
          });

          if (result.success) {
            logger.success(`Fixed ${result.addressedItems.length} item(s) for PR #${pr.number}`);
            handledPRs.add(pr.number);
          } else {
            logger.error(`Failed to fix PR #${pr.number}: ${result.error}`);
          }
        } catch (error) {
          logger.error(`Error fixing PR #${pr.number}`, error);
        }
      }
    }
  });

  monitor.on("checks_changed", (data) => {
    const { pr } = data;
    if (pr.checksPass === true) {
      logger.success(`${pc.cyan(`PR #${pr.number}`)}: CI checks now passing!`);
      handledPRs.add(pr.number);
    } else if (pr.checksPass === false) {
      logger.warn(`${pc.cyan(`PR #${pr.number}`)}: CI checks failing`);
    }
  });

  monitor.on("merged", (data) => {
    const { pr } = data;
    logger.success(`${pc.cyan(`PR #${pr.number}`)}: Merged! 🎉`);
    handledPRs.add(pr.number);
  });

  monitor.on("closed", (data) => {
    const { pr } = data;
    logger.warn(`${pc.cyan(`PR #${pr.number}`)}: Closed without merge`);
    handledPRs.add(pr.number);
  });

  // Handle errors to prevent unhandled exception crashes
  monitor.on("error", (data) => {
    const { pr, error } = data;
    const prId = pr?.number ? `PR #${pr.number}` : "Unknown PR";
    logger.error(`${pc.cyan(prId)}: Monitor error - ${error?.message ?? "Unknown error"}`);
    // Don't crash, continue monitoring other PRs
  });

  // Start monitoring all PRs
  for (const url of prUrls) {
    try {
      const monitored = await monitor.startMonitoring(url);
      const feedback = monitored.lastFeedback;

      console.error(
        `${pc.cyan(`PR #${monitored.prNumber}`)}: ${monitored.owner}/${monitored.repo}`
      );
      if (feedback) {
        const checksStatus =
          feedback.pr.checksPass === null
            ? "pending"
            : feedback.pr.checksPass
              ? pc.green("passing")
              : pc.red("failing");
        console.error(`  Checks: ${checksStatus}`);
      }
    } catch (error) {
      logger.error(`Failed to monitor ${url}`, error);
    }
  }

  console.error("");
  console.error(pc.dim("Watching for CI changes... Press Ctrl+C to stop"));
  console.error("");

  // Handle graceful shutdown
  const shutdown = (): void => {
    console.error("");
    logger.info("Stopping watch...");
    monitor.stopAll();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Wait until all PRs are handled or timeout
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      // Check if all PRs have been handled (merged, closed, or CI fixed)
      const allHandled = prUrls.every((url) => {
        const parsed = prService.parsePRUrl(url);
        return parsed && handledPRs.has(parsed.prNumber);
      });

      if (allHandled) {
        clearInterval(checkInterval);
        monitor.stopAll();
        logger.success("All PRs have been processed");
        resolve();
      }
    }, 5000);

    // Also resolve on timeout (1 hour)
    setTimeout(
      () => {
        clearInterval(checkInterval);
        monitor.stopAll();
        logger.warn("Watch timeout reached");
        resolve();
      },
      60 * 60 * 1000
    );
  });
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
