import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager, ParallelSession } from "../../core/state/state-manager.js";

export function createParallelStatusCommand(): Command {
  const command = new Command("parallel-status")
    .description("Show status of parallel work operations")
    .option("--all", "Show all parallel sessions (not just active)", false)
    .option("-s, --session <id>", "Show specific session details")
    .option("-l, --limit <n>", "Maximum sessions to show", parseInt, 10)
    .action(async (options: ParallelStatusOptions) => {
      try {
        await runParallelStatus(options);
      } catch (error) {
        logger.error("Failed to get parallel status", error);
        process.exit(1);
      }
    });

  return command;
}

interface ParallelStatusOptions {
  all: boolean;
  session?: string;
  limit: number;
}

async function runParallelStatus(options: ParallelStatusOptions): Promise<void> {
  const config = loadConfig();
  const dataDir = expandPath(config.dataDir);
  const stateManager = new StateManager(dataDir);

  try {
    if (options.session) {
      // Show specific session details
      const session = stateManager.getParallelSession(options.session);
      if (!session) {
        logger.error(`Parallel session not found: ${options.session}`);
        process.exit(1);
      }

      displaySessionDetails(stateManager, session);
    } else {
      // Show list of sessions
      const sessions = options.all
        ? stateManager.getAllParallelSessions(options.limit)
        : stateManager.getActiveParallelSessions();

      if (sessions.length === 0) {
        if (options.all) {
          console.error(pc.dim("No parallel sessions found."));
        } else {
          console.error(pc.dim("No active parallel sessions."));
          console.error(pc.dim("Use --all to show completed sessions."));
        }
        return;
      }

      displaySessionList(sessions);
    }
  } finally {
    stateManager.close();
  }
}

function displaySessionList(sessions: ParallelSession[]): void {
  console.error(pc.bold("Parallel Work Sessions"));
  console.error("");

  for (const session of sessions) {
    const statusColor = getStatusColor(session.status);
    const statusIcon = getStatusIcon(session.status);

    console.error(`${statusIcon} ${pc.bold(session.id)}`);
    console.error(`  Status: ${statusColor(session.status)}`);
    console.error(`  Started: ${formatDate(session.startedAt)}`);

    if (session.completedAt) {
      console.error(`  Completed: ${formatDate(session.completedAt)}`);
    }

    const progress = `${session.completedIssues}/${session.totalIssues} completed`;
    console.error(`  Progress: ${progress}`);

    if (session.failedIssues > 0) {
      console.error(`  Failed: ${pc.red(String(session.failedIssues))}`);
    }
    if (session.cancelledIssues > 0) {
      console.error(`  Cancelled: ${pc.yellow(String(session.cancelledIssues))}`);
    }

    console.error(`  Cost: $${session.totalCostUsd.toFixed(4)}`);

    if (session.totalDurationMs > 0) {
      console.error(`  Duration: ${(session.totalDurationMs / 1000).toFixed(1)}s`);
    }

    console.error("");
  }
}

function displaySessionDetails(stateManager: StateManager, session: ParallelSession): void {
  const statusColor = getStatusColor(session.status);
  const statusIcon = getStatusIcon(session.status);

  console.error(pc.bold(`Parallel Session: ${session.id}`));
  console.error("");

  console.error(`Status: ${statusIcon} ${statusColor(session.status)}`);
  console.error(`Started: ${formatDate(session.startedAt)}`);
  if (session.completedAt) {
    console.error(`Completed: ${formatDate(session.completedAt)}`);
  }
  console.error(`Max Concurrent: ${session.maxConcurrent}`);
  console.error(`Total Cost: $${session.totalCostUsd.toFixed(4)}`);
  if (session.totalDurationMs > 0) {
    console.error(`Duration: ${(session.totalDurationMs / 1000).toFixed(1)}s`);
  }

  console.error("");
  console.error(pc.bold("Issues:"));
  console.error("");

  // Get all issues for this session
  const issues = stateManager.getParallelSessionIssues(session.id);

  // Display as table
  const table: string[][] = [["Status", "Issue URL", "Cost", "Duration"]];

  for (const issue of issues) {
    const icon = getIssueStatusIcon(issue.status);
    const duration =
      issue.startedAt && issue.completedAt
        ? `${((issue.completedAt.getTime() - issue.startedAt.getTime()) / 1000).toFixed(1)}s`
        : issue.startedAt
          ? "..."
          : "-";

    table.push([icon, truncateUrl(issue.issueUrl), `$${issue.costUsd.toFixed(4)}`, duration]);

    if (issue.error) {
      table.push(["", pc.red(`  Error: ${issue.error.slice(0, 60)}`), "", ""]);
    }
  }

  // Print table
  for (const row of table) {
    console.error(`  ${row.join("  ")}`);
  }

  console.error("");
  console.error(pc.dim("Summary:"));
  console.error(`  Total: ${session.totalIssues}`);
  console.error(`  Completed: ${pc.green(String(session.completedIssues))}`);
  console.error(
    `  Failed: ${session.failedIssues > 0 ? pc.red(String(session.failedIssues)) : "0"}`
  );
  console.error(
    `  Cancelled: ${session.cancelledIssues > 0 ? pc.yellow(String(session.cancelledIssues)) : "0"}`
  );
}

function getStatusColor(status: string): (s: string) => string {
  switch (status) {
    case "active":
      return pc.cyan;
    case "completed":
      return pc.green;
    case "failed":
      return pc.red;
    case "cancelled":
      return pc.yellow;
    default:
      return pc.dim;
  }
}

function getStatusIcon(status: string): string {
  switch (status) {
    case "active":
      return pc.cyan("◐");
    case "completed":
      return pc.green("✓");
    case "failed":
      return pc.red("✗");
    case "cancelled":
      return pc.yellow("○");
    default:
      return " ";
  }
}

function getIssueStatusIcon(status: string): string {
  switch (status) {
    case "pending":
      return pc.dim("○");
    case "in_progress":
      return pc.cyan("◐");
    case "completed":
      return pc.green("✓");
    case "failed":
      return pc.red("✗");
    case "cancelled":
      return pc.yellow("○");
    default:
      return " ";
  }
}

function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60000) {
    return "just now";
  } else if (diff < 3600000) {
    const mins = Math.floor(diff / 60000);
    return `${mins} minute${mins > 1 ? "s" : ""} ago`;
  } else if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  } else {
    return date.toLocaleString();
  }
}

function truncateUrl(url: string): string {
  // Extract owner/repo#number from URL
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (match) {
    return `${match[1]}/${match[2]}#${match[3]}`;
  }
  return url.length > 50 ? url.slice(0, 47) + "..." : url;
}
