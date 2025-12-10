import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { GitOperations } from "../../core/git/git-operations.js";
import { IterationHandler } from "../../core/engine/index.js";
import { createProvider } from "../../core/ai/provider-factory.js";
import { PRService, FeedbackParser } from "../../core/github/index.js";

export function createIterateCommand(): Command {
  const command = new Command("iterate")
    .description("Address feedback on an existing PR")
    .argument("<pr-url>", "GitHub pull request URL")
    .option("-n, --dry-run", "Make changes locally without pushing", false)
    .option("-b, --max-budget <usd>", "Maximum budget for this iteration in USD", parseFloat)
    .option("-v, --verbose", "Enable verbose output", false)
    .action(async (prUrl: string, options: IterateOptions) => {
      if (options.verbose) {
        logger.configure({ level: "debug", verbose: true });
      }

      try {
        await runIterate(prUrl, options);
      } catch (error) {
        logger.error("Iteration failed", error);
        process.exit(1);
      }
    });

  return command;
}

interface IterateOptions {
  dryRun: boolean;
  maxBudget?: number;
  verbose: boolean;
}

async function runIterate(prUrl: string, options: IterateOptions): Promise<void> {
  logger.header("OSS Agent - Iterate on PR");

  // Load configuration
  const config = loadConfig();
  const dataDir = expandPath(config.dataDir);

  // Validate PR URL
  const prService = new PRService();
  const parsed = prService.parsePRUrl(prUrl);
  if (!parsed) {
    logger.error("Invalid PR URL. Expected format: https://github.com/owner/repo/pull/123");
    process.exit(1);
  }

  logger.info(`PR: ${pc.cyan(prUrl)}`);
  if (options.maxBudget) {
    logger.info(`Budget: $${options.maxBudget}`);
  }
  if (options.dryRun) {
    logger.warn("Dry run mode - changes will not be pushed");
  }

  // Initialize components
  const stateManager = new StateManager(dataDir);
  const gitOps = new GitOperations(config.git, dataDir);
  const aiProvider = await createProvider(config);

  // Check AI provider availability
  const available = await aiProvider.isAvailable();
  if (!available) {
    logger.error(`AI provider '${aiProvider.name}' is not available.`);
    stateManager.close();
    process.exit(1);
  }

  logger.info(`AI Provider: ${pc.green(aiProvider.name)}`);
  console.error("");

  // Check feedback first
  logger.info("Analyzing PR feedback...");
  const feedbackParser = new FeedbackParser();
  const { pr, reviews, comments, checks } = await prService.getPRFeedback(
    parsed.owner,
    parsed.repo,
    parsed.prNumber
  );
  const feedback = feedbackParser.parse(pr, reviews, comments, checks);

  console.error("");
  console.error(pc.dim("PR Status:"));
  console.error(`  State: ${pr.state}${pr.isDraft ? " (draft)" : ""}`);
  console.error(
    `  Mergeable: ${pr.mergeable === null ? "unknown" : pr.mergeable ? "yes" : "no (conflicts)"}`
  );
  console.error(
    `  Checks: ${pr.checksPass === null ? "pending" : pr.checksPass ? "passing" : "failing"}`
  );
  console.error("");
  console.error(pc.dim("Feedback Summary:"));
  console.error(`  ${feedback.summary}`);
  console.error("");

  if (!feedback.needsAttention) {
    logger.success("No actionable feedback to address");
    stateManager.close();
    return;
  }

  console.error(pc.dim("Actionable Items:"));
  for (const item of feedback.actionableItems) {
    const location = item.filePath
      ? `${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}`
      : "general";
    console.error(`  [${item.type}] ${item.description} (${location})`);
  }
  console.error("");

  // Create handler and run iteration
  const handler = new IterationHandler(config, stateManager, gitOps, aiProvider);

  try {
    const iterateOptions: Parameters<typeof handler.iterate>[0] = {
      prUrl,
      dryRun: options.dryRun,
    };
    if (options.maxBudget !== undefined) {
      iterateOptions.maxBudgetUsd = options.maxBudget;
    }
    const result = await handler.iterate(iterateOptions);

    console.error("");
    logger.header("Results");

    if (result.success) {
      if (result.addressedItems.length > 0) {
        logger.success(`Addressed ${result.addressedItems.length} feedback item(s)`);

        console.error("");
        console.error(pc.dim("Metrics:"));
        console.error(`  Turns: ${result.metrics.turns}`);
        console.error(`  Duration: ${(result.metrics.durationMs / 1000).toFixed(1)}s`);
        console.error(`  Files changed: ${result.filesChanged}`);
        if (result.metrics.costUsd > 0) {
          console.error(`  Cost: $${result.metrics.costUsd.toFixed(4)}`);
        }

        if (result.newCommitSha) {
          console.error("");
          console.error(pc.green(`New commit: ${result.newCommitSha.slice(0, 8)}`));
        }
      } else {
        logger.warn("No changes were made");
      }
    } else {
      logger.error(`Iteration failed: ${result.error}`);

      if (result.failedItems.length > 0) {
        console.error("");
        console.error(pc.dim(`Failed to address ${result.failedItems.length} item(s)`));
      }

      console.error("");
      console.error(pc.dim("Partial metrics:"));
      console.error(`  Turns: ${result.metrics.turns}`);
      console.error(`  Duration: ${(result.metrics.durationMs / 1000).toFixed(1)}s`);

      stateManager.close();
      process.exit(1);
    }
  } finally {
    stateManager.close();
  }
}
