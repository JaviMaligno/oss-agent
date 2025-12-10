import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

export function createCleanupCommand(): Command {
  const command = new Command("cleanup")
    .description("Clean up completed sessions and their worktrees")
    .option("--completed", "Clean up completed/merged sessions (safe)", false)
    .option("--failed", "Clean up failed/abandoned sessions", false)
    .option("--stale", "Clean up sessions older than 7 days", false)
    .option("--issue <issue-id>", "Clean up a specific issue's worktree")
    .option("--dry-run", "Show what would be cleaned without actually cleaning", false)
    .option("-v, --verbose", "Enable verbose output", false)
    .action(async (options: CleanupOptions) => {
      if (options.verbose) {
        logger.configure({ level: "debug", verbose: true });
      }

      try {
        await runCleanup(options);
      } catch (error) {
        logger.error("Cleanup failed", error);
        process.exit(1);
      }
    });

  return command;
}

interface CleanupOptions {
  completed: boolean;
  failed: boolean;
  stale: boolean;
  issue?: string;
  dryRun: boolean;
  verbose: boolean;
}

async function runCleanup(options: CleanupOptions): Promise<void> {
  logger.header("OSS Agent - Cleanup");

  const config = loadConfig();
  const dataDir = expandPath(config.dataDir);
  const stateManager = new StateManager(dataDir);
  const reposDir = join(dataDir, "repos");

  // Default to --completed if no options specified
  const cleanCompleted = options.completed || (!options.failed && !options.stale && !options.issue);
  const cleanFailed = options.failed;
  const cleanStale = options.stale;

  if (!cleanCompleted && !cleanFailed && !cleanStale && !options.issue) {
    console.error(pc.dim("Usage: oss-agent cleanup [options]"));
    console.error("");
    console.error(pc.dim("Options:"));
    console.error(pc.dim("  --completed    Clean up completed/merged sessions (default)"));
    console.error(pc.dim("  --failed       Clean up failed/abandoned sessions"));
    console.error(pc.dim("  --stale        Clean up sessions older than 7 days"));
    console.error(pc.dim("  --issue <id>   Clean up a specific issue's worktree"));
    console.error(pc.dim("  --dry-run      Show what would be cleaned"));
    stateManager.close();
    return;
  }

  let totalCleaned = 0;

  // Clean specific issue
  if (options.issue) {
    const cleaned = await cleanupIssue(options.issue, stateManager, reposDir, options.dryRun);
    totalCleaned += cleaned;
  } else {
    // Get all work records
    const workRecords = stateManager.getAllWorkRecords();

    for (const record of workRecords) {
      const issue = stateManager.getIssue(record.issueId);
      const session = stateManager.getLatestSessionForIssue(record.issueId);

      if (!issue || !session) continue;

      // Determine if this should be cleaned
      let shouldClean = false;
      let reason = "";

      // Completed sessions
      if (cleanCompleted && (issue.state === "merged" || issue.state === "closed")) {
        shouldClean = true;
        reason = `completed (${issue.state})`;
      }

      // Failed sessions
      if (cleanFailed && (issue.state === "abandoned" || session.status === "failed")) {
        shouldClean = true;
        reason = `failed (${session.status})`;
      }

      // Stale sessions (older than 7 days)
      if (cleanStale) {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        if (session.lastActivityAt < sevenDaysAgo) {
          // Only clean if not actively in progress
          if (session.status !== "active" && issue.state !== "in_progress") {
            shouldClean = true;
            reason = `stale (last activity: ${formatDate(session.lastActivityAt)})`;
          }
        }
      }

      if (shouldClean && record.worktreePath) {
        if (existsSync(record.worktreePath)) {
          console.error(`  ${pc.cyan(record.issueId)}: ${reason}`);
          console.error(`    Worktree: ${record.worktreePath}`);

          if (!options.dryRun) {
            await cleanupWorktree(record.worktreePath, reposDir, record.branchName);
          }

          totalCleaned++;
        }
      }
    }
  }

  console.error("");
  if (options.dryRun) {
    if (totalCleaned > 0) {
      logger.info(`Would clean ${totalCleaned} worktree(s). Run without --dry-run to clean.`);
    } else {
      logger.info("Nothing to clean.");
    }
  } else {
    if (totalCleaned > 0) {
      logger.success(`Cleaned ${totalCleaned} worktree(s).`);
    } else {
      logger.info("Nothing to clean.");
    }
  }

  stateManager.close();
}

async function cleanupIssue(
  issueId: string,
  stateManager: StateManager,
  reposDir: string,
  dryRun: boolean
): Promise<number> {
  let cleaned = 0;

  // Try exact match first
  let issue = stateManager.getIssue(issueId);

  // Try partial match if not found
  if (!issue) {
    const workRecords = stateManager
      .getAllWorkRecords()
      .filter((r) => r.issueId.includes(issueId) || r.issueId.endsWith(`#${issueId}`));

    if (workRecords.length === 0) {
      logger.warn(`No work records found for issue: ${issueId}`);
      return 0;
    }

    for (const record of workRecords) {
      if (record.worktreePath && existsSync(record.worktreePath)) {
        console.error(`  ${pc.cyan(record.issueId)}`);
        console.error(`    Worktree: ${record.worktreePath}`);

        if (!dryRun) {
          await cleanupWorktree(record.worktreePath, reposDir, record.branchName);
        }

        cleaned++;
      }
    }

    return cleaned;
  }

  // Found exact issue
  const workRecords = stateManager.getAllWorkRecords().filter((r) => r.issueId === issue.id);

  for (const record of workRecords) {
    if (record.worktreePath && existsSync(record.worktreePath)) {
      console.error(`  ${pc.cyan(record.issueId)}`);
      console.error(`    Worktree: ${record.worktreePath}`);

      if (!dryRun) {
        await cleanupWorktree(record.worktreePath, reposDir, record.branchName);
      }

      cleaned++;
    }
  }

  return cleaned;
}

async function cleanupWorktree(
  worktreePath: string,
  reposDir: string,
  branchName?: string
): Promise<void> {
  // Try to find the parent repo and use git worktree remove
  const ownerRepoMatch = worktreePath.match(/worktrees\/[^/]+-([^/]+)\/([^/]+)/);

  if (ownerRepoMatch) {
    const [, owner, repoWithIssue] = ownerRepoMatch;
    // Extract repo name (before # or end)
    const repo = repoWithIssue?.split("#")[0];
    const repoPath = join(reposDir, owner ?? "", repo ?? "");

    if (existsSync(repoPath)) {
      // Try git worktree remove first
      await new Promise<void>((resolve) => {
        const proc = spawn("git", ["worktree", "remove", worktreePath, "--force"], {
          cwd: repoPath,
          stdio: ["ignore", "pipe", "pipe"],
        });

        proc.on("close", () => {
          // Also try to delete the branch
          if (branchName) {
            const branchProc = spawn("git", ["branch", "-D", branchName], {
              cwd: repoPath,
              stdio: "ignore",
            });
            branchProc.on("close", () => resolve());
            branchProc.on("error", () => resolve());
          } else {
            resolve();
          }
        });

        proc.on("error", () => resolve());
      });
    }
  }

  // Force remove the directory if it still exists
  if (existsSync(worktreePath)) {
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch (error) {
      logger.debug(`Failed to remove directory: ${error}`);
    }
  }
}

function formatDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays < 1) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;

  return date.toLocaleDateString();
}
