/**
 * GitHub PR Service - Fetches PR data, reviews, comments, and check status
 */

import { spawn } from "node:child_process";
import { logger } from "../../infra/logger.js";
import {
  PullRequest,
  PRReview,
  PRComment,
  PRCheck,
  PRState,
  ReviewState,
  CheckStatus,
} from "../../types/pr.js";

export interface PRServiceOptions {
  /** GitHub CLI path */
  ghPath?: string;
}

export class PRService {
  private ghPath: string;

  constructor(options: PRServiceOptions = {}) {
    this.ghPath = options.ghPath ?? "gh";
  }

  /**
   * Parse a PR URL into owner, repo, and PR number
   */
  parsePRUrl(url: string): { owner: string; repo: string; prNumber: number } | null {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) {
      return null;
    }
    return {
      owner: match[1]!,
      repo: match[2]!,
      prNumber: parseInt(match[3]!, 10),
    };
  }

  /**
   * Fetch PR details
   */
  async getPR(owner: string, repo: string, prNumber: number): Promise<PullRequest> {
    const json = await this.runGh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      `${owner}/${repo}`,
      "--json",
      "number,title,body,state,isDraft,mergeable,headRefName,baseRefName,headRefOid,author,createdAt,updatedAt,comments,statusCheckRollup",
    ]);

    const data = JSON.parse(json);

    // Determine if checks pass
    let checksPass: boolean | null = null;
    if (data.statusCheckRollup && data.statusCheckRollup.length > 0) {
      checksPass = data.statusCheckRollup.every(
        (check: { status: string; conclusion: string }) =>
          check.status === "COMPLETED" && check.conclusion === "SUCCESS"
      );
    }

    return {
      id: `${owner}/${repo}#${prNumber}`,
      url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      number: prNumber,
      title: data.title,
      body: data.body ?? "",
      state: this.mapPRState(data.state),
      isDraft: data.isDraft ?? false,
      mergeable:
        data.mergeable === "MERGEABLE" ? true : data.mergeable === "CONFLICTING" ? false : null,
      headBranch: data.headRefName,
      baseBranch: data.baseRefName,
      headSha: data.headRefOid,
      author: data.author?.login ?? "unknown",
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
      linkedIssueUrl: null, // Would need separate query to get linked issues
      commentCount: data.comments?.length ?? 0,
      reviewCommentCount: 0, // Not available in gh pr view --json
      checksPass,
    };
  }

  /**
   * Fetch all reviews for a PR
   */
  async getReviews(owner: string, repo: string, prNumber: number): Promise<PRReview[]> {
    const json = await this.runGh([
      "api",
      `repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      "--paginate",
    ]);

    const data = JSON.parse(json);
    if (!Array.isArray(data)) {
      return [];
    }

    return data.map(
      (review: {
        id: number;
        state: string;
        user: { login: string } | null;
        body: string | null;
        submitted_at: string;
        commit_id: string;
      }) => ({
        id: String(review.id),
        prId: `${owner}/${repo}#${prNumber}`,
        state: this.mapReviewState(review.state),
        author: review.user?.login ?? "unknown",
        body: review.body,
        submittedAt: new Date(review.submitted_at),
        commitSha: review.commit_id,
      })
    );
  }

  /**
   * Fetch all comments (both PR comments and review comments)
   */
  async getComments(owner: string, repo: string, prNumber: number): Promise<PRComment[]> {
    const comments: PRComment[] = [];

    // Get issue comments (general PR comments)
    const issueCommentsJson = await this.runGh([
      "api",
      `repos/${owner}/${repo}/issues/${prNumber}/comments`,
      "--paginate",
    ]);

    const issueComments = JSON.parse(issueCommentsJson);
    if (Array.isArray(issueComments)) {
      for (const comment of issueComments) {
        comments.push({
          id: String(comment.id),
          prId: `${owner}/${repo}#${prNumber}`,
          author: comment.user?.login ?? "unknown",
          body: comment.body ?? "",
          createdAt: new Date(comment.created_at),
          updatedAt: new Date(comment.updated_at),
          isReviewComment: false,
          path: null,
          line: null,
          side: null,
          originalLine: null,
          inReplyToId: null,
        });
      }
    }

    // Get review comments (inline code comments)
    const reviewCommentsJson = await this.runGh([
      "api",
      `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      "--paginate",
    ]);

    const reviewComments = JSON.parse(reviewCommentsJson);
    if (Array.isArray(reviewComments)) {
      for (const comment of reviewComments) {
        comments.push({
          id: String(comment.id),
          prId: `${owner}/${repo}#${prNumber}`,
          author: comment.user?.login ?? "unknown",
          body: comment.body ?? "",
          createdAt: new Date(comment.created_at),
          updatedAt: new Date(comment.updated_at),
          isReviewComment: true,
          path: comment.path ?? null,
          line: comment.line ?? comment.original_line ?? null,
          side: comment.side ?? null,
          originalLine: comment.original_line ?? null,
          inReplyToId: comment.in_reply_to_id ? String(comment.in_reply_to_id) : null,
        });
      }
    }

    // Sort by creation date
    comments.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    return comments;
  }

  /**
   * Fetch CI check status for a PR
   */
  async getChecks(owner: string, repo: string, prNumber: number): Promise<PRCheck[]> {
    // First get the head SHA
    const prJson = await this.runGh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      `${owner}/${repo}`,
      "--json",
      "headRefOid",
    ]);

    const prData = JSON.parse(prJson);
    const headSha = prData.headRefOid;

    if (!headSha) {
      return [];
    }

    // Get check runs for the commit
    const checksJson = await this.runGh([
      "api",
      `repos/${owner}/${repo}/commits/${headSha}/check-runs`,
    ]);

    const checksData = JSON.parse(checksJson);
    const checkRuns = checksData.check_runs ?? [];

    return checkRuns.map(
      (check: {
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        details_url: string | null;
        started_at: string | null;
        completed_at: string | null;
        output: { summary: string | null; text: string | null } | null;
      }) => ({
        id: String(check.id),
        name: check.name,
        status: this.mapCheckStatus(check.status, check.conclusion),
        conclusion: check.conclusion,
        detailsUrl: check.details_url,
        startedAt: check.started_at ? new Date(check.started_at) : null,
        completedAt: check.completed_at ? new Date(check.completed_at) : null,
        outputSummary: check.output?.summary ?? null,
        outputText: check.output?.text ?? null,
      })
    );
  }

  /**
   * Get check run logs (for failed checks)
   */
  async getCheckLogs(owner: string, repo: string, checkRunId: string): Promise<string | null> {
    try {
      const logs = await this.runGh([
        "api",
        `repos/${owner}/${repo}/actions/jobs/${checkRunId}/logs`,
        "--method",
        "GET",
      ]);
      return logs;
    } catch {
      // Logs may not be available
      return null;
    }
  }

  /**
   * Fetch complete PR feedback data
   */
  async getPRFeedback(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<{
    pr: PullRequest;
    reviews: PRReview[];
    comments: PRComment[];
    checks: PRCheck[];
  }> {
    logger.debug(`Fetching feedback for ${owner}/${repo}#${prNumber}`);

    const [pr, reviews, comments, checks] = await Promise.all([
      this.getPR(owner, repo, prNumber),
      this.getReviews(owner, repo, prNumber),
      this.getComments(owner, repo, prNumber),
      this.getChecks(owner, repo, prNumber),
    ]);

    return { pr, reviews, comments, checks };
  }

  /**
   * Check if gh CLI is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.runGh(["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  private mapPRState(state: string): PRState {
    switch (state.toUpperCase()) {
      case "OPEN":
        return "open";
      case "CLOSED":
        return "closed";
      case "MERGED":
        return "merged";
      default:
        return "open";
    }
  }

  private mapReviewState(state: string): ReviewState {
    switch (state.toUpperCase()) {
      case "APPROVED":
        return "approved";
      case "CHANGES_REQUESTED":
        return "changes_requested";
      case "COMMENTED":
        return "commented";
      case "DISMISSED":
        return "dismissed";
      case "PENDING":
      default:
        return "pending";
    }
  }

  private mapCheckStatus(status: string, conclusion: string | null): CheckStatus {
    if (status === "completed") {
      switch (conclusion) {
        case "success":
        case "neutral": // Informational-only checks (like some code review bots)
          return "success";
        case "failure":
        case "timed_out":
        case "startup_failure":
          return "failure";
        case "cancelled":
          return "cancelled";
        case "skipped":
        case "action_required": // Usually means "optional" or "needs manual approval"
        case "stale":
          return "skipped";
        default:
          // For unknown conclusions, treat as skipped rather than failing
          // This handles cases like "skipping" from Vercel Agent Review
          return "skipped";
      }
    }
    return "pending";
  }

  private runGh(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ghPath, args, {
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
}
