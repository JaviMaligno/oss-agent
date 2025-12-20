import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { GitOperations } from "../../core/git/git-operations.js";
import { ReviewService } from "../../core/engine/review-service.js";
import { createProvider } from "../../core/ai/provider-factory.js";
import { PRService } from "../../core/github/index.js";

export function createReviewCommand(): Command {
  const command = new Command("review")
    .description("Review a PR with a second AI agent")
    .argument("<pr-url>", "GitHub pull request URL to review")
    .option("--auto-fix", "Automatically fix issues found", true)
    .option("--no-auto-fix", "Disable automatic fixes")
    .option("--post-comment", "Post review as PR comment", true)
    .option("--no-post-comment", "Don't post review comment")
    .option("-n, --dry-run", "Review without making changes or posting", false)
    .option("-m, --mock", "Run in mock mode for verification", false)
    .option("-b, --max-budget <usd>", "Maximum budget in USD", parseFloat)
    .option("-v, --verbose", "Enable verbose output", false)
    .action(async (prUrl: string, options: ReviewOptions) => {
      if (options.verbose) {
        logger.configure({ level: "debug", verbose: true });
      }

      try {
        await runReview(prUrl, options);
      } catch (error) {
        logger.error("Review failed", error);
        process.exit(1);
      }
    });

  return command;
}

interface ReviewOptions {
  autoFix: boolean;
  postComment: boolean;
  dryRun: boolean;
  mock: boolean;
  maxBudget?: number;
  verbose: boolean;
}

async function runReview(prUrl: string, options: ReviewOptions): Promise<void> {
  logger.header("OSS Agent - PR Review");

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

  logger.info(`Reviewing: ${pc.cyan(prUrl)}`);
  logger.info(`Auto-fix: ${options.autoFix ? pc.green("enabled") : pc.yellow("disabled")}`);
  logger.info(`Post comment: ${options.postComment ? pc.green("enabled") : pc.yellow("disabled")}`);
  if (options.mock) {
    logger.warn("Mode: MOCK (Verification)");
  }
  if (options.maxBudget) {
    logger.info(`Budget: $${options.maxBudget}`);
  }
  if (options.dryRun) {
    logger.warn("Dry run mode - no changes will be made");
  }
  console.error("");

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

  // Create review service and run
  const reviewService = new ReviewService(config, stateManager, gitOps, aiProvider);

  try {
    const result = await reviewService.review({
      prUrl,
      autoFix: options.autoFix,
      postComment: options.postComment,
      dryRun: options.dryRun,
      mockMode: options.mock,
      maxBudgetUsd: options.maxBudget,
    });

    console.error("");
    logger.header("Review Results");

    // Print summary
    console.error(pc.dim("Summary:"));
    console.error(`  ${result.summary}`);
    console.error("");

    // Print verdict
    if (result.approved) {
      console.error(pc.green("✓ APPROVED - No blocking issues found"));
    } else {
      console.error(pc.red("✗ CHANGES REQUESTED"));
      console.error("");
      console.error(pc.dim("Blockers:"));
      for (const blocker of result.blockers) {
        console.error(`  ${pc.red("•")} ${blocker}`);
      }
    }

    // Print suggestions
    if (result.suggestions.length > 0) {
      console.error("");
      console.error(pc.dim("Suggestions:"));
      for (const s of result.suggestions) {
        const severityColor =
          s.severity === "critical"
            ? pc.red
            : s.severity === "major"
              ? pc.yellow
              : s.severity === "minor"
                ? pc.blue
                : pc.dim;
        const fixedLabel = s.wasAutoFixed ? pc.green(" [FIXED]") : "";
        console.error(
          `  ${severityColor(`[${s.severity.toUpperCase()}]`)} ${s.file}${s.line ? `:${s.line}` : ""}${fixedLabel}`
        );
        console.error(`    ${s.description}`);
      }
    }

    // Print metrics
    console.error("");
    console.error(pc.dim("Metrics:"));
    console.error(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.error(`  Auto-fixed: ${result.autoFixedCount} issue(s)`);
    console.error(`  Comment posted: ${result.commentPosted ? "yes" : "no"}`);
    if (result.commitSha) {
      console.error(`  New commit: ${result.commitSha.slice(0, 8)}`);
    }

    if (!result.approved) {
      stateManager.close();
      process.exit(1);
    }
  } finally {
    stateManager.close();
  }
}
