import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { GitOperations } from "../../core/git/git-operations.js";
import { WorktreeManager } from "../../core/git/worktree-manager.js";
import { ParallelOrchestrator } from "../../core/engine/parallel-orchestrator.js";
import { createProvider } from "../../core/ai/provider-factory.js";

export function createWorkCommand(): Command {
  const command = new Command("work")
    .description("Work on a specific issue and create a PR")
    .argument("<issue-url>", "GitHub issue URL")
    .option("-n, --dry-run", "Analyze issue without making changes", false)
    .option("-b, --max-budget <usd>", "Maximum budget for this issue in USD", parseFloat)
    .option("-r, --resume", "Resume from previous session if available", false)
    .option("--skip-pr", "Skip creating pull request", false)
    .option("--review", "Automatically review PR created", false)
    .option("--wait-for-ci", "Wait for CI checks after PR creation (default: true)")
    .option("--no-wait-for-ci", "Skip waiting for CI checks")
    .option("--auto-fix-ci", "Automatically fix failed CI checks (default: true)")
    .option("--no-auto-fix-ci", "Don't auto-fix failed CI checks")
    .option("-v, --verbose", "Enable verbose output", false)
    .action(async (issueUrl: string, options: WorkOptions) => {
      if (options.verbose) {
        logger.configure({ level: "debug", verbose: true });
      }

      try {
        await runWork(issueUrl, options);
      } catch (error) {
        logger.error("Work failed", error);
        process.exit(1);
      }
    });

  return command;
}

interface WorkOptions {
  dryRun: boolean;
  maxBudget?: number;
  resume: boolean;
  skipPr: boolean;
  review: boolean;
  waitForCi?: boolean;
  autoFixCi?: boolean;
  verbose: boolean;
}

async function runWork(issueUrl: string, options: WorkOptions): Promise<void> {
  logger.header("OSS Agent - Work on Issue");

  // Load configuration
  const config = loadConfig();
  const dataDir = expandPath(config.dataDir);
  const hardeningConfig = config.hardening;

  // Validate issue URL
  if (!issueUrl.includes("github.com") || !issueUrl.includes("/issues/")) {
    logger.error("Invalid issue URL. Expected format: https://github.com/owner/repo/issues/123");
    process.exit(1);
  }

  logger.info(`Issue: ${pc.cyan(issueUrl)}`);
  logger.info(`Mode: ${pc.yellow(config.ai.executionMode)}`);
  if (options.maxBudget) {
    logger.info(`Budget: $${options.maxBudget}`);
  }
  if (options.dryRun) {
    logger.warn("Dry run mode - no changes will be made");
  }

  // Initialize services
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

  // Create orchestrator with maxConcurrent=1 for single issue processing
  const orchestrator = new ParallelOrchestrator(
    config,
    stateManager,
    gitOps,
    worktreeManager,
    aiProvider
  );

  try {
    const processOptions: Parameters<typeof orchestrator.processIssues>[0] = {
      issueUrls: [issueUrl],
      maxConcurrent: 1,
      skipConflictCheck: true, // No need for conflict detection with a single issue
    };

    if (options.maxBudget !== undefined) {
      processOptions.maxBudgetUsd = options.maxBudget;
    }
    if (options.skipPr || options.dryRun) {
      processOptions.skipPR = true;
    }
    if (options.resume) {
      processOptions.resume = true;
    }
    if (options.review) {
      processOptions.review = true;
    }
    if (options.waitForCi !== undefined) {
      processOptions.waitForCIChecks = options.waitForCi;
    }
    if (options.autoFixCi !== undefined) {
      processOptions.autoFixCI = options.autoFixCi;
    }

    const orchestratorResult = await orchestrator.processIssues(processOptions);

    console.error("");
    logger.header("Results");

    // Extract the single result
    const result = orchestratorResult.results[0]?.result;
    const error = orchestratorResult.results[0]?.error;

    if (result?.success) {
      logger.success("Issue processed successfully!");

      console.error("");
      console.error(pc.dim("Metrics:"));
      console.error(`  Turns: ${result.metrics.turns}`);
      console.error(`  Duration: ${(result.metrics.durationMs / 1000).toFixed(1)}s`);
      console.error(`  Files changed: ${result.metrics.filesChanged}`);
      console.error(`  Lines changed: ${result.metrics.linesChanged}`);
      if (result.metrics.costUsd > 0) {
        console.error(`  Cost: $${result.metrics.costUsd.toFixed(4)}`);
      }

      if (result.prUrl) {
        console.error("");
        console.error(pc.green(`Pull Request: ${result.prUrl}`));
      }

      if (result.ciResult) {
        console.error("");
        console.error(pc.dim("CI Checks:"));
        console.error(`  Status: ${result.ciResult.finalStatus}`);
        console.error(`  Iterations: ${result.ciResult.iterations.length}`);
        if (result.ciResult.finalStatus === "success") {
          console.error(pc.green(`  All ${result.ciResult.finalChecks.length} checks passed!`));
        } else if (
          result.ciResult.finalStatus !== "no_checks" &&
          result.ciResult.finalStatus !== "skipped"
        ) {
          console.error(pc.yellow(`  ${result.ciResult.summary}`));
        }
      }
    } else {
      logger.error(`Issue processing failed: ${error ?? result?.error ?? "Unknown error"}`);

      if (result) {
        console.error("");
        console.error(pc.dim("Partial metrics:"));
        console.error(`  Turns: ${result.metrics.turns}`);
        console.error(`  Duration: ${(result.metrics.durationMs / 1000).toFixed(1)}s`);
      }

      stateManager.close();
      process.exit(1);
    }
  } finally {
    stateManager.close();
  }
}
