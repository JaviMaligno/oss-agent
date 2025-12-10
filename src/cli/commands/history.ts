import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { IssueState } from "../../types/issue.js";

export function createHistoryCommand(): Command {
  const command = new Command("history")
    .description("Show operation history")
    .option("-n, --limit <count>", "Number of items to show", "20")
    .option("-s, --state <state>", "Filter by issue state")
    .option("--sessions", "Show session details", false)
    .option("--json", "Output as JSON", false)
    .option("-v, --verbose", "Enable verbose output", false)
    .action(async (options: HistoryOptions) => {
      if (options.verbose) {
        logger.configure({ level: "debug", verbose: true });
      }

      try {
        await runHistory(options);
      } catch (error) {
        logger.error("History failed", error);
        process.exit(1);
      }
    });

  return command;
}

interface HistoryOptions {
  limit: string;
  state?: string;
  sessions: boolean;
  json: boolean;
  verbose: boolean;
}

async function runHistory(options: HistoryOptions): Promise<void> {
  const config = loadConfig();
  const dataDir = expandPath(config.dataDir);
  const stateManager = new StateManager(dataDir);
  const limit = parseInt(options.limit, 10);

  try {
    // Get statistics first
    const stats = stateManager.getStats();

    if (options.json) {
      await outputJson(stateManager, options, limit, stats);
      return;
    }

    // Human-readable output
    logger.header("OSS Agent - History");
    console.error("");

    // Summary stats
    console.error(pc.dim("Summary:"));
    console.error(`  Total issues: ${stats.totalIssues}`);
    console.error(`  Total sessions: ${stats.totalSessions}`);
    console.error(`  Active sessions: ${stats.activeSessions}`);
    console.error(`  Total cost: $${stats.totalCostUsd.toFixed(4)}`);
    console.error("");

    // Issues by state
    console.error(pc.dim("Issues by state:"));
    const stateOrder: IssueState[] = [
      "discovered",
      "queued",
      "in_progress",
      "pr_created",
      "awaiting_feedback",
      "iterating",
      "merged",
      "closed",
      "abandoned",
    ];
    for (const state of stateOrder) {
      const count = stats.issuesByState[state] ?? 0;
      if (count > 0) {
        const color = getStateColor(state);
        console.error(`  ${color(state)}: ${count}`);
      }
    }
    console.error("");

    // Recent issues
    console.error(pc.dim(`Recent issues (limit ${limit}):`));
    console.error("");

    // Get issues - optionally filtered by state
    let issues;
    if (options.state) {
      const validStates: IssueState[] = [
        "discovered",
        "queued",
        "in_progress",
        "pr_created",
        "awaiting_feedback",
        "iterating",
        "merged",
        "closed",
        "abandoned",
      ];
      if (!validStates.includes(options.state as IssueState)) {
        logger.error(`Invalid state: ${options.state}. Valid: ${validStates.join(", ")}`);
        return;
      }
      issues = stateManager.getIssuesByState(options.state as IssueState);
    } else {
      // Get all issues by querying each state
      issues = [];
      for (const state of stateOrder) {
        issues.push(...stateManager.getIssuesByState(state));
      }
      // Sort by updated date
      issues.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    }

    // Limit
    issues = issues.slice(0, limit);

    if (issues.length === 0) {
      console.error(pc.dim("  No issues found"));
    } else {
      for (const issue of issues) {
        const stateColor = getStateColor(issue.state);
        console.error(
          `${pc.cyan(issue.id)} - ${issue.title.slice(0, 50)}${issue.title.length > 50 ? "..." : ""}`
        );
        console.error(`  State: ${stateColor(issue.state)}`);
        console.error(`  URL: ${issue.url}`);
        if (issue.hasLinkedPR && issue.linkedPRUrl) {
          console.error(`  PR: ${issue.linkedPRUrl}`);
        }
        console.error(`  Updated: ${formatDate(issue.updatedAt)}`);

        if (options.sessions) {
          const session = stateManager.getLatestSessionForIssue(issue.id);
          if (session) {
            console.error(pc.dim(`  Session: ${session.id}`));
            console.error(pc.dim(`    Status: ${session.status}`));
            console.error(pc.dim(`    Turns: ${session.turnCount}`));
            console.error(pc.dim(`    Cost: $${session.costUsd.toFixed(4)}`));
            if (session.error) {
              console.error(pc.red(`    Error: ${session.error}`));
            }
          }
        }

        // Show transitions
        const transitions = stateManager.getIssueTransitions(issue.id);
        if (transitions.length > 0 && options.verbose) {
          console.error(pc.dim("  Transitions:"));
          for (const t of transitions.slice(-3)) {
            console.error(pc.dim(`    ${t.fromState} → ${t.toState} (${t.reason})`));
          }
        }

        console.error("");
      }
    }
  } finally {
    stateManager.close();
  }
}

async function outputJson(
  stateManager: StateManager,
  options: HistoryOptions,
  limit: number,
  stats: ReturnType<typeof StateManager.prototype.getStats>
): Promise<void> {
  const stateOrder: IssueState[] = [
    "discovered",
    "queued",
    "in_progress",
    "pr_created",
    "awaiting_feedback",
    "iterating",
    "merged",
    "closed",
    "abandoned",
  ];

  let issues;
  if (options.state) {
    issues = stateManager.getIssuesByState(options.state as IssueState);
  } else {
    issues = [];
    for (const state of stateOrder) {
      issues.push(...stateManager.getIssuesByState(state));
    }
    issues.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  issues = issues.slice(0, limit);

  const output = {
    stats,
    issues: issues.map((issue) => {
      const result: Record<string, unknown> = { ...issue };
      if (options.sessions) {
        const session = stateManager.getLatestSessionForIssue(issue.id);
        result.latestSession = session;
      }
      return result;
    }),
  };

  console.log(JSON.stringify(output, null, 2));
}

function getStateColor(state: IssueState): (text: string) => string {
  switch (state) {
    case "discovered":
    case "queued":
      return pc.blue;
    case "in_progress":
    case "iterating":
      return pc.yellow;
    case "pr_created":
    case "awaiting_feedback":
      return pc.cyan;
    case "merged":
      return pc.green;
    case "closed":
      return pc.gray;
    case "abandoned":
      return pc.red;
    default:
      return pc.white;
  }
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
