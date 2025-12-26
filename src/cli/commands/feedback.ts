/**
 * feedback command - List feedback on open PRs (both own and monitored)
 */

import { Command } from "commander";
import { spawn } from "node:child_process";
import pc from "picocolors";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { PRService } from "../../core/github/pr-service.js";
import { FeedbackParser } from "../../core/github/feedback-parser.js";
import { logger } from "../../infra/logger.js";
import type { FeedbackParseResult, ActionableFeedback } from "../../types/pr.js";

interface FeedbackOptions {
  mine: boolean;
  repo?: string;
  actionable: boolean;
  limit: string;
  json: boolean;
  details: boolean;
}

interface PRFeedbackInfo {
  url: string;
  repo: string;
  number: number;
  title: string;
  state: string;
  mergeable: boolean | null;
  reviewDecision: string | null;
  reviewCount: number;
  commentCount: number;
  actionableCount: number;
  actionableItems: ActionableFeedback[];
  checksPass: boolean | null;
  needsAttention: boolean;
}

export function createFeedbackCommand(): Command {
  return new Command("feedback")
    .description("List feedback on open PRs")
    .option("--mine", "Only show PRs authored by current user", false)
    .option("-r, --repo <repo>", "Filter by repository (owner/repo)")
    .option("-a, --actionable", "Only show PRs with actionable feedback", false)
    .option("-n, --limit <count>", "Maximum number of PRs to show", "20")
    .option("--json", "Output as JSON", false)
    .option("-d, --details", "Show detailed feedback items", false)
    .action(async (options: FeedbackOptions) => {
      await runFeedback(options);
    });
}

async function runFeedback(options: FeedbackOptions): Promise<void> {
  try {
    const config = loadConfig();
    const stateManager = new StateManager(expandPath(config.dataDir));
    const prService = new PRService();
    const feedbackParser = new FeedbackParser();

    console.log(pc.dim("Fetching PRs..."));

    // Collect PRs from multiple sources
    const prUrls = new Set<string>();

    // 1. Get PRs from GitHub search (user's own PRs)
    if (options.mine || !options.repo) {
      const searchPrs = await searchUserPRs(options.repo);
      for (const url of searchPrs) {
        prUrls.add(url);
      }
    }

    // 2. Get monitored PRs from state
    const monitoredPrs = stateManager.getMonitoredPRs("open");
    for (const pr of monitoredPrs) {
      if (!options.repo || pr.prUrl.includes(options.repo)) {
        prUrls.add(pr.prUrl);
      }
    }

    // 3. If specific repo requested, search it
    if (options.repo && !options.mine) {
      const repoPrs = await searchRepoPRs(options.repo);
      for (const url of repoPrs) {
        prUrls.add(url);
      }
    }

    if (prUrls.size === 0) {
      console.log(pc.dim("\nNo open PRs found."));
      stateManager.close();
      return;
    }

    console.log(pc.dim(`Found ${prUrls.size} PR(s), fetching feedback...`));

    // Fetch feedback for each PR
    const feedbackInfos: PRFeedbackInfo[] = [];
    const limit = parseInt(options.limit, 10);

    for (const url of prUrls) {
      if (feedbackInfos.length >= limit) break;

      const parsed = prService.parsePRUrl(url);
      if (!parsed) continue;

      try {
        const { pr, reviews, comments, checks } = await prService.getPRFeedback(
          parsed.owner,
          parsed.repo,
          parsed.prNumber
        );

        // Skip closed/merged PRs
        if (pr.state !== "open") continue;

        const feedback = feedbackParser.parse(pr, reviews, comments, checks);
        const actionableItems = feedback.actionableItems.filter((item) => !item.addressed);

        // Filter if actionable only
        if (options.actionable && actionableItems.length === 0) continue;

        feedbackInfos.push({
          url: pr.url,
          repo: `${parsed.owner}/${parsed.repo}`,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          mergeable: pr.mergeable,
          reviewDecision: getReviewDecision(feedback),
          reviewCount: reviews.length,
          commentCount: comments.length,
          actionableCount: actionableItems.length,
          actionableItems,
          checksPass: pr.checksPass,
          needsAttention: actionableItems.length > 0 || pr.mergeable === false,
        });
      } catch (error) {
        logger.debug(`Failed to fetch feedback for ${url}: ${error}`);
      }
    }

    // Sort by needsAttention first, then by actionableCount
    feedbackInfos.sort((a, b) => {
      if (a.needsAttention !== b.needsAttention) {
        return a.needsAttention ? -1 : 1;
      }
      return b.actionableCount - a.actionableCount;
    });

    // Output
    if (options.json) {
      outputJson(feedbackInfos);
    } else {
      outputHuman(feedbackInfos, options.details);
    }

    stateManager.close();
  } catch (error) {
    logger.error(`Failed to list feedback: ${error}`);
    process.exit(1);
  }
}

/**
 * Search for user's own open PRs using gh CLI
 */
async function searchUserPRs(repo?: string): Promise<string[]> {
  const args = [
    "search",
    "prs",
    "--author",
    "@me",
    "--state",
    "open",
    "--json",
    "url",
    "--limit",
    "50",
  ];

  if (repo) {
    args.push("--repo", repo);
  }

  try {
    const output = await runGh(args);
    const prs = JSON.parse(output);
    return prs.map((pr: { url: string }) => pr.url);
  } catch (error) {
    logger.debug(`Failed to search user PRs: ${error}`);
    return [];
  }
}

/**
 * Search for open PRs in a specific repo
 */
async function searchRepoPRs(repo: string): Promise<string[]> {
  const args = ["pr", "list", "--repo", repo, "--state", "open", "--json", "url", "--limit", "50"];

  try {
    const output = await runGh(args);
    const prs = JSON.parse(output);
    return prs.map((pr: { url: string }) => pr.url);
  } catch (error) {
    logger.debug(`Failed to search repo PRs: ${error}`);
    return [];
  }
}

/**
 * Get review decision from feedback
 */
function getReviewDecision(feedback: FeedbackParseResult): string | null {
  // Check summary for review state indicators
  const summary = feedback.summary.toLowerCase();
  if (summary.includes("changes requested") || summary.includes("request_changes")) {
    return "CHANGES_REQUESTED";
  }
  if (summary.includes("approved")) {
    return "APPROVED";
  }
  // Check if there are review comments
  const hasReviewFeedback = feedback.actionableItems.some((item) => item.source === "review");
  if (hasReviewFeedback) {
    return "REVIEW_PENDING";
  }
  return null;
}

function runGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("gh", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`gh command failed: ${stderr || stdout}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

function outputJson(prs: PRFeedbackInfo[]): void {
  const needsAttention = prs.filter((pr) => pr.needsAttention).length;

  console.log(
    JSON.stringify(
      {
        prs: prs.map((pr) => ({
          url: pr.url,
          repo: pr.repo,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          mergeable: pr.mergeable,
          reviewDecision: pr.reviewDecision,
          reviewCount: pr.reviewCount,
          commentCount: pr.commentCount,
          actionableCount: pr.actionableCount,
          actionableItems: pr.actionableItems.map((item) => ({
            id: item.id,
            type: item.type,
            description: item.description,
            filePath: item.filePath,
            lineNumber: item.lineNumber,
          })),
          checksPass: pr.checksPass,
          needsAttention: pr.needsAttention,
        })),
        summary: {
          total: prs.length,
          needsAttention,
          withConflicts: prs.filter((pr) => pr.mergeable === false).length,
          withActionableFeedback: prs.filter((pr) => pr.actionableCount > 0).length,
        },
      },
      null,
      2
    )
  );
}

function outputHuman(prs: PRFeedbackInfo[], verbose: boolean): void {
  if (prs.length === 0) {
    console.log(pc.dim("\nNo PRs with feedback found."));
    return;
  }

  console.log(pc.bold("\n═══ PR Feedback Summary ═══\n"));

  for (const pr of prs) {
    // Header with attention indicator
    const attentionIcon = pr.needsAttention ? pc.yellow("⚠ ") : "  ";
    const conflictIcon = pr.mergeable === false ? pc.red(" [CONFLICTS]") : "";
    const checksIcon = pr.checksPass === false ? pc.red(" [CI FAILING]") : "";

    console.log(
      attentionIcon + pc.bold(`#${pr.number}`) + pc.dim(` ${pr.repo}`) + conflictIcon + checksIcon
    );
    console.log(pc.dim(`   ${pr.title.slice(0, 60)}${pr.title.length > 60 ? "..." : ""}`));
    console.log(pc.dim(`   ${pr.url}`));

    // Review status
    const reviewStatus = getReviewStatusDisplay(pr);
    console.log(`   ${reviewStatus}`);

    // Feedback summary
    if (pr.actionableCount > 0) {
      console.log(
        `   ${pc.yellow(`${pr.actionableCount} actionable item${pr.actionableCount !== 1 ? "s" : ""}`)}`
      );

      if (verbose) {
        // Group by type
        const byType = new Map<string, ActionableFeedback[]>();
        for (const item of pr.actionableItems) {
          const existing = byType.get(item.type) ?? [];
          existing.push(item);
          byType.set(item.type, existing);
        }

        for (const [type, items] of byType) {
          console.log(pc.dim(`     ${type}:`));
          for (const item of items.slice(0, 3)) {
            const location = item.filePath
              ? pc.dim(` (${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""})`)
              : "";
            console.log(
              `       • ${item.description.slice(0, 50)}${item.description.length > 50 ? "..." : ""}${location}`
            );
          }
          if (items.length > 3) {
            console.log(pc.dim(`       ... and ${items.length - 3} more`));
          }
        }
      }
    } else {
      console.log(`   ${pc.green("✓ No actionable feedback")}`);
    }

    console.log();
  }

  // Summary
  const needsAttention = prs.filter((pr) => pr.needsAttention).length;
  const withConflicts = prs.filter((pr) => pr.mergeable === false).length;
  const withFeedback = prs.filter((pr) => pr.actionableCount > 0).length;

  console.log(pc.dim("─".repeat(40)));
  console.log(
    pc.bold("Summary: ") +
      `${prs.length} PR${prs.length !== 1 ? "s" : ""}` +
      (needsAttention > 0 ? pc.yellow(`, ${needsAttention} need attention`) : "") +
      (withConflicts > 0 ? pc.red(`, ${withConflicts} with conflicts`) : "") +
      (withFeedback > 0 ? `, ${withFeedback} with feedback` : "")
  );

  if (needsAttention > 0) {
    console.log(pc.dim("\nTip: Run 'oss-agent iterate <pr-url>' to address feedback"));
  }
}

function getReviewStatusDisplay(pr: PRFeedbackInfo): string {
  const parts: string[] = [];

  if (pr.reviewDecision === "APPROVED") {
    parts.push(pc.green("✓ Approved"));
  } else if (pr.reviewDecision === "CHANGES_REQUESTED") {
    parts.push(pc.red("✗ Changes requested"));
  } else if (pr.reviewCount > 0) {
    parts.push(pc.dim(`${pr.reviewCount} review${pr.reviewCount !== 1 ? "s" : ""}`));
  } else {
    parts.push(pc.dim("No reviews"));
  }

  if (pr.commentCount > 0) {
    parts.push(pc.dim(`${pr.commentCount} comment${pr.commentCount !== 1 ? "s" : ""}`));
  }

  return parts.join(" • ");
}
