/**
 * prs command - List monitored PRs with their feedback status
 */

import { Command } from "commander";
import pc from "picocolors";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager, MonitoredPRState } from "../../core/state/state-manager.js";
import { PRService } from "../../core/github/pr-service.js";
import { FeedbackParser } from "../../core/github/feedback-parser.js";
import { logger } from "../../infra/logger.js";

interface PRsOptions {
  state?: string;
  limit: string;
  check: boolean;
  json: boolean;
  verbose: boolean;
}

interface PRDisplayInfo {
  url: string;
  owner: string;
  repo: string;
  number: number;
  state: MonitoredPRState;
  feedbackCount: number;
  iterationCount: number;
  lastCheckAt: Date | null;
  needsAttention: boolean;
}

export function createPrsCommand(): Command {
  return new Command("prs")
    .description("List monitored PRs with their feedback status")
    .option("-s, --state <state>", "Filter by state (open, merged, closed)")
    .option("-n, --limit <count>", "Number of PRs to show", "20")
    .option("--check", "Check all PRs for new feedback now", false)
    .option("--json", "Output as JSON", false)
    .option("-v, --verbose", "Show detailed information", false)
    .action(async (options: PRsOptions) => {
      await runPrs(options);
    });
}

async function runPrs(options: PRsOptions): Promise<void> {
  try {
    const config = loadConfig();
    const stateManager = new StateManager(expandPath(config.dataDir));

    // Get monitored PRs
    const stateFilter = options.state as MonitoredPRState | undefined;
    let prs = stateManager.getMonitoredPRs(stateFilter);

    // Apply limit
    const limit = parseInt(options.limit, 10);
    if (prs.length > limit) {
      prs = prs.slice(0, limit);
    }

    // Check for new feedback if requested
    if (options.check && prs.length > 0) {
      console.log(pc.dim("Checking PRs for new feedback..."));
      const prService = new PRService();
      const feedbackParser = new FeedbackParser();

      for (const pr of prs) {
        if (pr.state !== "open") continue;

        try {
          const feedback = await prService.getPRFeedback(pr.owner, pr.repo, pr.prNumber);
          const parsed = feedbackParser.parse(
            feedback.pr,
            feedback.reviews,
            feedback.comments,
            feedback.checks
          );
          const feedbackCount = parsed.actionableItems.length;
          // Update the PR in state
          stateManager.updateMonitoredPR(pr.prUrl, {
            lastCheckAt: new Date(),
            feedbackCount,
          });
          // Update local copy for display
          pr.lastCheckAt = new Date();
          pr.feedbackCount = feedbackCount;
        } catch (error) {
          logger.debug(`Failed to check PR ${pr.prUrl}: ${error}`);
        }
      }
    }

    // Convert to display info
    const displayInfos: PRDisplayInfo[] = prs.map((pr) => ({
      url: pr.prUrl,
      owner: pr.owner,
      repo: pr.repo,
      number: pr.prNumber,
      state: pr.state,
      feedbackCount: pr.feedbackCount,
      iterationCount: pr.iterationCount,
      lastCheckAt: pr.lastCheckAt,
      needsAttention: pr.state === "open" && pr.feedbackCount > 0,
    }));

    // Output
    if (options.json) {
      outputJson(displayInfos);
    } else {
      outputHuman(displayInfos, options.verbose);
    }

    stateManager.close();
  } catch (error) {
    logger.error(`Failed to list PRs: ${error}`);
    process.exit(1);
  }
}

function outputJson(prs: PRDisplayInfo[]): void {
  const needsAttention = prs.filter((pr) => pr.needsAttention).length;

  console.log(
    JSON.stringify(
      {
        prs: prs.map((pr) => ({
          url: pr.url,
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
          state: pr.state,
          feedbackCount: pr.feedbackCount,
          iterationCount: pr.iterationCount,
          lastCheckAt: pr.lastCheckAt?.toISOString() ?? null,
          needsAttention: pr.needsAttention,
        })),
        summary: {
          total: prs.length,
          open: prs.filter((pr) => pr.state === "open").length,
          merged: prs.filter((pr) => pr.state === "merged").length,
          closed: prs.filter((pr) => pr.state === "closed").length,
          needsAttention,
        },
      },
      null,
      2
    )
  );
}

function outputHuman(prs: PRDisplayInfo[], verbose: boolean): void {
  if (prs.length === 0) {
    console.log(pc.dim("No monitored PRs found."));
    console.log(pc.dim("\nUse 'oss-agent work <issue-url>' to create PRs."));
    return;
  }

  console.log(pc.bold("\nOSS Agent - Monitored PRs"));
  console.log(pc.dim("═".repeat(40)));
  console.log();

  for (const pr of prs) {
    const stateColor = getStateColor(pr.state);
    const attentionIndicator = pr.needsAttention ? pc.yellow(" ⚠") : "";

    console.log(
      pc.bold(`PR #${pr.number}`) + pc.dim(` - ${pr.owner}/${pr.repo}`) + attentionIndicator
    );
    console.log(`  ${pc.dim("URL:")}        ${pr.url}`);
    console.log(`  ${pc.dim("State:")}      ${stateColor(pr.state)}`);

    if (verbose || pr.feedbackCount > 0) {
      console.log(
        `  ${pc.dim("Feedback:")}   ${pr.feedbackCount} item${pr.feedbackCount !== 1 ? "s" : ""}`
      );
    }

    if (verbose || pr.iterationCount > 0) {
      console.log(`  ${pc.dim("Iterations:")} ${pr.iterationCount}`);
    }

    if (pr.lastCheckAt) {
      console.log(`  ${pc.dim("Last check:")} ${formatRelativeTime(pr.lastCheckAt)}`);
    }

    console.log();
  }

  // Summary
  const openCount = prs.filter((pr) => pr.state === "open").length;
  const needsAttention = prs.filter((pr) => pr.needsAttention).length;

  console.log(pc.dim("─".repeat(40)));
  console.log(
    `${pc.bold("Summary:")} ${prs.length} PR${prs.length !== 1 ? "s" : ""} monitored` +
      (openCount > 0 ? `, ${openCount} open` : "") +
      (needsAttention > 0
        ? pc.yellow(`, ${needsAttention} need${needsAttention !== 1 ? "" : "s"} attention`)
        : "")
  );
}

function getStateColor(state: MonitoredPRState): (text: string) => string {
  switch (state) {
    case "open":
      return pc.green;
    case "merged":
      return pc.magenta;
    case "closed":
      return pc.red;
    default:
      return pc.dim;
  }
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}
