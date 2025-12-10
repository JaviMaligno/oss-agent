import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { GitOperations } from "../../core/git/git-operations.js";
import { IssueProcessor } from "../../core/engine/index.js";
import { createProvider } from "../../core/ai/provider-factory.js";
import { Session } from "../../types/session.js";

export function createResumeCommand(): Command {
  const command = new Command("resume")
    .description("Resume an interrupted session")
    .argument("[session-id]", "Session ID to resume (defaults to most recent)")
    .option("-l, --list", "List resumable sessions", false)
    .option("-b, --max-budget <usd>", "Maximum budget for resumed session", parseFloat)
    .option("--skip-pr", "Skip creating pull request", false)
    .option("-v, --verbose", "Enable verbose output", false)
    .action(async (sessionId: string | undefined, options: ResumeOptions) => {
      if (options.verbose) {
        logger.configure({ level: "debug", verbose: true });
      }

      try {
        await runResume(sessionId, options);
      } catch (error) {
        logger.error("Resume failed", error);
        process.exit(1);
      }
    });

  return command;
}

interface ResumeOptions {
  list: boolean;
  maxBudget?: number;
  skipPr: boolean;
  verbose: boolean;
}

async function runResume(sessionId: string | undefined, options: ResumeOptions): Promise<void> {
  const config = loadConfig();
  const dataDir = expandPath(config.dataDir);
  const stateManager = new StateManager(dataDir);

  try {
    // List mode
    if (options.list) {
      await listResumableSessions(stateManager);
      return;
    }

    logger.header("OSS Agent - Resume Session");

    // Find session to resume
    let session: Session | null = null;

    if (sessionId) {
      session = stateManager.getSession(sessionId);
      if (!session) {
        logger.error(`Session not found: ${sessionId}`);
        process.exit(1);
      }
    } else {
      // Find most recent resumable session
      const sessions = findResumableSessions(stateManager);
      if (sessions.length === 0) {
        logger.warn("No resumable sessions found");
        console.error("");
        console.error(pc.dim("Use 'oss-agent resume --list' to see all sessions"));
        return;
      }
      session = sessions[0]!;
      logger.info(`Found resumable session: ${session.id}`);
    }

    // Validate session can be resumed
    if (!session.canResume) {
      logger.error("Session cannot be resumed");
      if (session.error) {
        console.error(pc.dim(`Error: ${session.error}`));
      }
      process.exit(1);
    }

    if (session.status === "completed") {
      logger.warn("Session already completed");
      return;
    }

    // Get associated issue
    const issue = stateManager.getIssue(session.issueId);
    if (!issue) {
      logger.error(`Issue not found: ${session.issueId}`);
      process.exit(1);
    }

    console.error("");
    console.error(pc.dim("Session details:"));
    console.error(`  ID: ${session.id}`);
    console.error(`  Status: ${session.status}`);
    console.error(`  Issue: ${issue.title}`);
    console.error(`  URL: ${issue.url}`);
    console.error(`  Turns so far: ${session.turnCount}`);
    console.error(`  Cost so far: $${session.costUsd.toFixed(4)}`);
    if (session.prUrl) {
      console.error(`  PR: ${session.prUrl}`);
    }
    console.error("");

    // Initialize components
    const gitOps = new GitOperations(config.git, dataDir);
    const aiProvider = await createProvider(config);

    // Check AI provider availability
    const available = await aiProvider.isAvailable();
    if (!available) {
      logger.error(`AI provider '${aiProvider.name}' is not available.`);
      process.exit(1);
    }

    logger.info(`AI Provider: ${pc.green(aiProvider.name)}`);
    console.error("");

    // Create processor and resume
    const processor = new IssueProcessor(config, stateManager, gitOps, aiProvider);

    const processOptions: Parameters<typeof processor.processIssue>[0] = {
      issueUrl: issue.url,
      resume: true,
      skipPR: options.skipPr,
    };
    if (options.maxBudget !== undefined) {
      processOptions.maxBudgetUsd = options.maxBudget;
    }

    const result = await processor.processIssue(processOptions);

    console.error("");
    logger.header("Results");

    if (result.success) {
      logger.success("Session resumed and completed successfully!");

      console.error("");
      console.error(pc.dim("Metrics:"));
      console.error(`  Total turns: ${result.metrics.turns}`);
      console.error(`  Duration: ${(result.metrics.durationMs / 1000).toFixed(1)}s`);
      console.error(`  Files changed: ${result.metrics.filesChanged}`);
      console.error(`  Lines changed: ${result.metrics.linesChanged}`);
      console.error(`  Total cost: $${result.metrics.costUsd.toFixed(4)}`);

      if (result.prUrl) {
        console.error("");
        console.error(pc.green(`Pull Request: ${result.prUrl}`));
      }
    } else {
      logger.error(`Resume failed: ${result.error}`);
      process.exit(1);
    }
  } finally {
    stateManager.close();
  }
}

function findResumableSessions(stateManager: StateManager): Session[] {
  // Get all active sessions
  const activeSessions = stateManager.getActiveSessions();

  // Filter to resumable ones
  const resumable = activeSessions.filter((s) => s.canResume);

  // Sort by last activity (most recent first)
  resumable.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());

  return resumable;
}

async function listResumableSessions(stateManager: StateManager): Promise<void> {
  logger.header("OSS Agent - Resumable Sessions");
  console.error("");

  const sessions = findResumableSessions(stateManager);

  if (sessions.length === 0) {
    console.error(pc.dim("No resumable sessions found"));
    console.error("");
    console.error(pc.dim("Sessions may not be resumable if:"));
    console.error(pc.dim("  - They completed successfully"));
    console.error(pc.dim("  - They failed with an unrecoverable error"));
    console.error(pc.dim("  - The working directory was cleaned up"));
    return;
  }

  console.error(`Found ${sessions.length} resumable session(s):`);
  console.error("");

  for (const session of sessions) {
    const issue = stateManager.getIssue(session.issueId);
    const issueTitle = issue?.title.slice(0, 40) ?? "Unknown";

    console.error(`${pc.cyan(session.id)}`);
    console.error(`  Issue: ${issueTitle}${(issue?.title.length ?? 0) > 40 ? "..." : ""}`);
    console.error(`  Status: ${session.status}`);
    console.error(`  Turns: ${session.turnCount}`);
    console.error(`  Cost: $${session.costUsd.toFixed(4)}`);
    console.error(`  Last activity: ${formatDate(session.lastActivityAt)}`);
    if (session.error) {
      console.error(`  ${pc.red(`Error: ${session.error}`)}`);
    }
    console.error("");
  }

  console.error(pc.dim("To resume a session, run:"));
  console.error(pc.dim(`  oss-agent resume <session-id>`));
  console.error("");
  console.error(pc.dim("Or resume the most recent:"));
  console.error(pc.dim("  oss-agent resume"));
}

function formatDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}
