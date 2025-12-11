import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";

export function createCancelCommand(): Command {
  const command = new Command("cancel")
    .description("Cancel parallel work on issue(s)")
    .argument("[session-id]", "Parallel session ID to cancel (omit for most recent)")
    .option("--all", "Cancel all active parallel sessions", false)
    .option("-f, --force", "Force cancel without confirmation", false)
    .action(async (sessionId: string | undefined, options: CancelOptions) => {
      try {
        await runCancel(sessionId, options);
      } catch (error) {
        logger.error("Cancel failed", error);
        process.exit(1);
      }
    });

  return command;
}

interface CancelOptions {
  all: boolean;
  force: boolean;
}

async function runCancel(sessionId: string | undefined, options: CancelOptions): Promise<void> {
  const config = loadConfig();
  const dataDir = expandPath(config.dataDir);
  const stateManager = new StateManager(dataDir);

  try {
    const activeSessions = stateManager.getActiveParallelSessions();

    if (activeSessions.length === 0) {
      console.error(pc.dim("No active parallel sessions to cancel."));
      return;
    }

    if (options.all) {
      // Cancel all active sessions
      if (!options.force) {
        console.error(`About to cancel ${activeSessions.length} active session(s):`);
        for (const session of activeSessions) {
          console.error(`  - ${session.id} (${session.totalIssues} issues)`);
        }
        console.error("");
        console.error(pc.yellow("Use --force to confirm cancellation."));
        return;
      }

      for (const session of activeSessions) {
        cancelSession(stateManager, session.id);
        logger.info(`Cancelled session: ${session.id}`);
      }

      console.error(pc.green(`Cancelled ${activeSessions.length} session(s).`));
    } else {
      // Cancel specific session or most recent
      const targetId = sessionId ?? activeSessions[0]?.id;

      if (!targetId) {
        console.error(pc.dim("No session ID provided and no active sessions found."));
        return;
      }

      const session = stateManager.getParallelSession(targetId);

      if (!session) {
        logger.error(`Session not found: ${targetId}`);
        process.exit(1);
      }

      if (session.status !== "active") {
        console.error(pc.dim(`Session ${targetId} is not active (status: ${session.status}).`));
        return;
      }

      if (!options.force) {
        const issues = stateManager.getParallelSessionIssues(targetId);
        const pending = issues.filter((i) => i.status === "pending" || i.status === "in_progress");

        console.error(`About to cancel session: ${targetId}`);
        console.error(`  Total issues: ${session.totalIssues}`);
        console.error(`  Pending/In-progress: ${pending.length}`);
        console.error(`  Already completed: ${session.completedIssues}`);
        console.error("");
        console.error(pc.yellow("Use --force to confirm cancellation."));
        return;
      }

      cancelSession(stateManager, targetId);
      logger.success(`Cancelled session: ${targetId}`);
    }
  } finally {
    stateManager.close();
  }
}

function cancelSession(stateManager: StateManager, sessionId: string): void {
  // Get all issues in the session
  const issues = stateManager.getParallelSessionIssues(sessionId);

  // Cancel pending and in-progress issues
  let cancelledCount = 0;
  for (const issue of issues) {
    if (issue.status === "pending" || issue.status === "in_progress") {
      stateManager.updateParallelSessionIssue(sessionId, issue.issueUrl, {
        status: "cancelled",
      });
      cancelledCount++;
    }
  }

  // Update session status
  const session = stateManager.getParallelSession(sessionId);
  if (session) {
    stateManager.updateParallelSession(sessionId, {
      status: "cancelled",
      cancelledIssues: session.cancelledIssues + cancelledCount,
    });
  }
}
