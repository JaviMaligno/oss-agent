import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { GitOperations } from "../../core/git/git-operations.js";
import { IterationHandler } from "../../core/engine/index.js";
import { createProvider } from "../../core/ai/provider-factory.js";
import { PRService, FeedbackParser, PRMonitor } from "../../core/github/index.js";

export function createWatchCommand(): Command {
  const command = new Command("watch")
    .description("Watch PRs for feedback and automatically iterate")
    .argument("[pr-urls...]", "PR URLs to watch (defaults to all active PRs)")
    .option("-i, --interval <seconds>", "Poll interval in seconds", "60")
    .option("-b, --max-budget <usd>", "Maximum budget per iteration in USD", parseFloat)
    .option("--auto-iterate", "Automatically iterate when feedback is detected", false)
    .option("--once", "Check once and exit (no continuous watching)", false)
    .option("-v, --verbose", "Enable verbose output", false)
    .action(async (prUrls: string[], options: WatchOptions) => {
      if (options.verbose) {
        logger.configure({ level: "debug", verbose: true });
      }

      try {
        await runWatch(prUrls, options);
      } catch (error) {
        logger.error("Watch failed", error);
        process.exit(1);
      }
    });

  return command;
}

interface WatchOptions {
  interval: string;
  maxBudget?: number;
  autoIterate: boolean;
  once: boolean;
  verbose: boolean;
}

async function runWatch(prUrls: string[], options: WatchOptions): Promise<void> {
  logger.header("OSS Agent - Watch Mode");

  const config = loadConfig();
  const dataDir = expandPath(config.dataDir);
  const pollIntervalMs = parseInt(options.interval, 10) * 1000;

  // Initialize components
  const stateManager = new StateManager(dataDir);
  const gitOps = new GitOperations(config.git, dataDir);
  const prService = new PRService();
  const feedbackParser = new FeedbackParser();

  // If no URLs provided, find active PRs from work records
  if (prUrls.length === 0) {
    const workRecords = stateManager.getAllWorkRecords();
    prUrls = workRecords
      .filter((r) => r.prUrl)
      .map((r) => r.prUrl!)
      .slice(0, 10); // Limit to 10 most recent

    if (prUrls.length === 0) {
      logger.warn("No PRs to watch. Use 'oss-agent work' to create a PR first.");
      stateManager.close();
      return;
    }

    logger.info(`Found ${prUrls.length} PR(s) to watch from recent work`);
  }

  // Validate PR URLs
  const validUrls: string[] = [];
  for (const url of prUrls) {
    const parsed = prService.parsePRUrl(url);
    if (parsed) {
      validUrls.push(url);
    } else {
      logger.warn(`Skipping invalid PR URL: ${url}`);
    }
  }

  if (validUrls.length === 0) {
    logger.error("No valid PR URLs to watch");
    stateManager.close();
    process.exit(1);
  }

  logger.info(`Watching ${validUrls.length} PR(s)`);
  logger.info(`Poll interval: ${options.interval}s`);
  if (options.autoIterate) {
    logger.info(`Auto-iterate: ${pc.green("enabled")}`);
  }
  console.error("");

  // Single check mode
  if (options.once) {
    await checkPRsOnce(validUrls, prService, feedbackParser, stateManager);
    stateManager.close();
    return;
  }

  // Initialize AI provider for auto-iteration
  let iterationHandler: IterationHandler | null = null;
  if (options.autoIterate) {
    const aiProvider = await createProvider(config);
    const available = await aiProvider.isAvailable();
    if (!available) {
      logger.warn("AI provider not available - auto-iterate disabled");
    } else {
      iterationHandler = new IterationHandler(config, stateManager, gitOps, aiProvider);
      logger.info(`AI Provider: ${pc.green(aiProvider.name)}`);
    }
  }

  // Create monitor
  const monitor = new PRMonitor(prService, feedbackParser, {
    pollIntervalMs,
    inactivityTimeoutMins: 120, // 2 hours
  });

  // Set up event handlers
  monitor.on("feedback", async (data) => {
    const { pr, feedback } = data;
    logger.info(`${pc.cyan(`PR #${pr.number}`)}: New feedback detected`);

    if (feedback) {
      const actionableCount = feedback.actionableItems.length;
      if (actionableCount > 0) {
        console.error(`  ${actionableCount} actionable item(s)`);

        if (iterationHandler && options.autoIterate) {
          logger.info("Auto-iterating to address feedback...");
          try {
            const iterateOptions: Parameters<typeof iterationHandler.iterate>[0] = {
              prUrl: pr.url,
            };
            if (options.maxBudget !== undefined) {
              iterateOptions.maxBudgetUsd = options.maxBudget;
            }
            const result = await iterationHandler.iterate(iterateOptions);
            if (result.success) {
              logger.success(`Addressed ${result.addressedItems.length} item(s)`);
            } else {
              logger.error(`Iteration failed: ${result.error}`);
            }
          } catch (error) {
            logger.error("Auto-iteration error", error);
          }
        }
      }
    }
  });

  monitor.on("checks_changed", (data) => {
    const { pr } = data;
    const status = pr.checksPass === null ? "pending" : pr.checksPass ? "passing" : "failing";
    logger.info(`${pc.cyan(`PR #${pr.number}`)}: CI status changed to ${status}`);
  });

  monitor.on("merged", (data) => {
    const { pr } = data;
    logger.success(`${pc.cyan(`PR #${pr.number}`)}: Merged! 🎉`);
  });

  monitor.on("closed", (data) => {
    const { pr } = data;
    logger.warn(`${pc.cyan(`PR #${pr.number}`)}: Closed without merge`);
  });

  monitor.on("error", (data) => {
    logger.error(`Monitor error: ${data.error?.message}`);
  });

  // Start monitoring all PRs
  console.error(pc.dim("Starting watch..."));
  console.error("");

  for (const url of validUrls) {
    try {
      const monitored = await monitor.startMonitoring(url);
      const feedback = monitored.lastFeedback;

      console.error(
        `${pc.cyan(`PR #${monitored.prNumber}`)} (${monitored.owner}/${monitored.repo})`
      );
      if (feedback) {
        console.error(`  State: ${feedback.pr.state}${feedback.pr.isDraft ? " (draft)" : ""}`);
        console.error(
          `  Checks: ${feedback.pr.checksPass === null ? "pending" : feedback.pr.checksPass ? "passing" : "failing"}`
        );
        console.error(`  Actionable items: ${feedback.actionableItems.length}`);
        console.error(`  ${feedback.summary}`);
      }
      console.error("");
    } catch (error) {
      logger.error(`Failed to start monitoring ${url}`, error);
    }
  }

  console.error(pc.dim("Watching for changes... Press Ctrl+C to stop"));
  console.error("");

  // Handle graceful shutdown
  const shutdown = () => {
    console.error("");
    logger.info("Stopping watch...");
    monitor.stopAll();
    stateManager.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process running
  await new Promise(() => {
    // Never resolves - keeps the process alive until signal
  });
}

async function checkPRsOnce(
  prUrls: string[],
  prService: PRService,
  feedbackParser: FeedbackParser,
  _stateManager: StateManager
): Promise<void> {
  console.error(pc.dim("Checking PRs...\n"));

  for (const url of prUrls) {
    const parsed = prService.parsePRUrl(url);
    if (!parsed) continue;

    try {
      const { pr, reviews, comments, checks } = await prService.getPRFeedback(
        parsed.owner,
        parsed.repo,
        parsed.prNumber
      );

      const feedback = feedbackParser.parse(pr, reviews, comments, checks);

      console.error(`${pc.cyan(`PR #${pr.number}`)} - ${pr.title}`);
      console.error(`  URL: ${pr.url}`);
      console.error(`  State: ${pr.state}${pr.isDraft ? " (draft)" : ""}`);
      console.error(
        `  Mergeable: ${pr.mergeable === null ? "unknown" : pr.mergeable ? "yes" : "no (conflicts)"}`
      );
      console.error(
        `  Checks: ${pr.checksPass === null ? "pending" : pr.checksPass ? "passing" : "failing"}`
      );
      console.error("");

      if (feedback.actionableItems.length > 0) {
        console.error(pc.yellow(`  ${feedback.actionableItems.length} actionable item(s):`));
        for (const item of feedback.actionableItems.slice(0, 5)) {
          const location = item.filePath ? ` (${item.filePath})` : "";
          console.error(`    [${item.type}]${location} ${item.description}`);
        }
        if (feedback.actionableItems.length > 5) {
          console.error(`    ... and ${feedback.actionableItems.length - 5} more`);
        }
      } else {
        console.error(pc.green("  No actionable feedback"));
      }

      console.error("");
      console.error(pc.dim(`  Summary: ${feedback.summary}`));
      console.error("");
    } catch (error) {
      logger.error(`Failed to check ${url}`, error);
    }
  }
}
