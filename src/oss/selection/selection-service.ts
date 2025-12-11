import { spawn } from "node:child_process";
import { logger } from "../../infra/logger.js";
import type { GitHubIssueInfo, IssueComment } from "../../types/issue.js";
import type { Project } from "../../types/project.js";
import type { OSSConfig } from "../../types/config.js";

export interface SelectionConfig {
  filterLabels?: string[] | undefined;
  excludeLabels?: string[] | undefined;
  requireNoExistingPR?: boolean | undefined;
  limit?: number | undefined;
  state?: "open" | "closed" | "all" | undefined;
}

export interface IssueScore {
  total: number;
  breakdown: {
    complexity: number;
    engagement: number;
    recency: number;
    labels: number;
    clarity: number;
  };
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  createdAt: string;
  updatedAt: string;
  author: { login: string };
  // gh issue list returns comments as an array
  comments: Array<{ id: string; author: { login: string }; body: string; createdAt: string }>;
  // gh issue list returns assignees as an array
  assignees: Array<{ login: string }>;
}

interface GitHubPRSearchResult {
  number: number;
  title: string;
  headRefName: string;
  state: string;
}

/**
 * SelectionService - Find and prioritize issues to work on
 */
export class SelectionService {
  constructor(private ossConfig?: OSSConfig) {}

  /**
   * Find issues from a project matching criteria
   */
  async findIssues(project: Project, config?: SelectionConfig): Promise<GitHubIssueInfo[]> {
    const effectiveConfig: SelectionConfig = {
      filterLabels: config?.filterLabels ?? this.ossConfig?.filterLabels ?? [],
      excludeLabels: config?.excludeLabels ?? this.ossConfig?.excludeLabels ?? [],
      requireNoExistingPR:
        config?.requireNoExistingPR ?? this.ossConfig?.requireNoExistingPR ?? true,
      limit: config?.limit ?? 30,
      state: config?.state ?? "open",
    };

    logger.debug(`Finding issues for ${project.fullName}`);

    try {
      const issues = await this.fetchIssues(project.owner, project.name, effectiveConfig);

      // Filter by labels
      let filtered = this.filterByLabels(issues, effectiveConfig);

      // Filter out issues with existing PRs if required
      if (effectiveConfig.requireNoExistingPR) {
        filtered = await this.filterOutIssuesWithPRs(project.owner, project.name, filtered);
      }

      // Sort by score
      const scored = filtered.map((issue) => ({
        issue,
        score: this.scoreIssue(issue),
      }));

      return scored
        .sort((a, b) => b.score.total - a.score.total)
        .slice(0, effectiveConfig.limit)
        .map((s) => s.issue);
    } catch (error) {
      logger.error(`Failed to find issues for ${project.fullName}: ${error}`);
      return [];
    }
  }

  /**
   * Score an issue for contribution suitability
   */
  scoreIssue(issue: GitHubIssueInfo): IssueScore {
    const breakdown = {
      complexity: 0,
      engagement: 0,
      recency: 0,
      labels: 0,
      clarity: 0,
    };

    // Complexity scoring (prefer simpler issues)
    const bodyLength = issue.body?.length ?? 0;
    if (bodyLength > 100 && bodyLength < 2000) {
      breakdown.complexity += 20; // Well-described but not overwhelming
    } else if (bodyLength >= 2000) {
      breakdown.complexity += 10; // Very detailed, might be complex
    } else {
      breakdown.complexity += 5; // Too short, unclear
    }

    // Engagement scoring (some engagement is good, too much might be contentious)
    const comments = issue.comments?.length ?? 0;
    if (comments === 0) {
      breakdown.engagement += 15; // Fresh issue, no contention
    } else if (comments <= 3) {
      breakdown.engagement += 20; // Some discussion, clarifications available
    } else if (comments <= 10) {
      breakdown.engagement += 10; // Active discussion
    } else {
      breakdown.engagement += 5; // Too much discussion, might be contentious
    }

    // Recency scoring (prefer newer issues)
    const daysSinceCreated = Math.floor(
      (Date.now() - issue.createdAt.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (daysSinceCreated < 7) {
      breakdown.recency += 25;
    } else if (daysSinceCreated < 30) {
      breakdown.recency += 20;
    } else if (daysSinceCreated < 90) {
      breakdown.recency += 10;
    } else {
      breakdown.recency += 5;
    }

    // Label scoring
    const goodLabels = [
      "good first issue",
      "good-first-issue",
      "help wanted",
      "help-wanted",
      "beginner",
      "easy",
    ];
    const hasGoodLabel = issue.labels.some((l) =>
      goodLabels.some((gl) => l.toLowerCase().includes(gl.toLowerCase().replace(" ", "-")))
    );
    if (hasGoodLabel) {
      breakdown.labels += 20;
    }

    // Enhancement labels are usually easier than bugs
    if (
      issue.labels.some(
        (l) => l.toLowerCase().includes("enhancement") || l.toLowerCase().includes("feature")
      )
    ) {
      breakdown.labels += 5;
    }

    // Clarity scoring based on title
    const titleWords = issue.title.split(/\s+/).length;
    if (titleWords >= 5 && titleWords <= 15) {
      breakdown.clarity += 15; // Good descriptive title
    } else if (titleWords >= 3) {
      breakdown.clarity += 10;
    } else {
      breakdown.clarity += 5; // Too short, unclear
    }

    const total =
      breakdown.complexity +
      breakdown.engagement +
      breakdown.recency +
      breakdown.labels +
      breakdown.clarity;

    return { total, breakdown };
  }

  /**
   * Check if an issue has a linked PR or branch
   */
  async hasExistingPR(owner: string, repo: string, issueNumber: number): Promise<boolean> {
    try {
      // Search for PRs that mention the issue
      const result = await this.gh([
        "api",
        "-X",
        "GET",
        `search/issues?q=repo:${owner}/${repo}+type:pr+${issueNumber}+in:body&per_page=5`,
        "--jq",
        ".total_count",
      ]);

      const count = parseInt(result.trim(), 10);
      return count > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get issues that are good candidates for contribution
   */
  async getGoodFirstIssues(project: Project, limit = 10): Promise<GitHubIssueInfo[]> {
    return this.findIssues(project, {
      filterLabels: ["good first issue", "good-first-issue", "help wanted", "beginner"],
      limit,
    });
  }

  /**
   * Fetch issues from GitHub
   */
  private async fetchIssues(
    owner: string,
    repo: string,
    config: SelectionConfig
  ): Promise<GitHubIssueInfo[]> {
    const result = await this.gh([
      "issue",
      "list",
      "-R",
      `${owner}/${repo}`,
      "--state",
      config.state ?? "open",
      "--limit",
      String(config.limit ?? 30),
      "--json",
      "number,title,body,state,labels,createdAt,updatedAt,author,comments,assignees",
    ]);

    const issues = JSON.parse(result) as GitHubIssue[];

    return issues.map((issue) => this.mapGitHubIssueToIssue(owner, repo, issue));
  }

  /**
   * Filter issues by labels
   */
  private filterByLabels(issues: GitHubIssueInfo[], config: SelectionConfig): GitHubIssueInfo[] {
    let filtered = issues;

    // Filter by required labels (if any specified, issue must have at least one)
    if (config.filterLabels && config.filterLabels.length > 0) {
      filtered = filtered.filter((issue) =>
        issue.labels.some((label) =>
          config.filterLabels?.some((fl) =>
            label.toLowerCase().includes(fl.toLowerCase().replace(" ", "-"))
          )
        )
      );
    }

    // Exclude by labels
    if (config.excludeLabels && config.excludeLabels.length > 0) {
      filtered = filtered.filter(
        (issue) =>
          !issue.labels.some((label) =>
            config.excludeLabels?.some((el) =>
              label.toLowerCase().includes(el.toLowerCase().replace(" ", "-"))
            )
          )
      );
    }

    // Exclude assigned issues
    filtered = filtered.filter((issue) => issue.assignees.length === 0);

    return filtered;
  }

  /**
   * Filter out issues that already have PRs
   */
  private async filterOutIssuesWithPRs(
    owner: string,
    repo: string,
    issues: GitHubIssueInfo[]
  ): Promise<GitHubIssueInfo[]> {
    // Get list of open PRs for reference
    let openPRs: GitHubPRSearchResult[] = [];
    try {
      const prResult = await this.gh([
        "pr",
        "list",
        "-R",
        `${owner}/${repo}`,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,title,headRefName,state",
      ]);
      openPRs = JSON.parse(prResult) as GitHubPRSearchResult[];
    } catch {
      // If we can't get PRs, don't filter
      return issues;
    }

    // Filter issues where a PR title or branch mentions the issue number
    return issues.filter((issue) => {
      const issueRef = `#${issue.number}`;
      const issueNumStr = String(issue.number);

      const hasPR = openPRs.some(
        (pr) =>
          pr.title.includes(issueRef) ||
          pr.title.includes(issueNumStr) ||
          pr.headRefName.includes(issueNumStr)
      );

      return !hasPR;
    });
  }

  /**
   * Map GitHub issue to our GitHubIssueInfo type
   */
  private mapGitHubIssueToIssue(
    owner: string,
    repo: string,
    ghIssue: GitHubIssue
  ): GitHubIssueInfo {
    return {
      id: `${owner}/${repo}#${ghIssue.number}`,
      url: `https://github.com/${owner}/${repo}/issues/${ghIssue.number}`,
      number: ghIssue.number,
      title: ghIssue.title,
      body: ghIssue.body ?? "",
      state: ghIssue.state === "OPEN" ? "open" : "closed",
      labels: ghIssue.labels.map((l) => l.name),
      createdAt: new Date(ghIssue.createdAt),
      updatedAt: new Date(ghIssue.updatedAt),
      author: ghIssue.author.login,
      comments: this.mapComments(ghIssue.comments),
      assignees: ghIssue.assignees.map((a) => a.login),
      repository: {
        owner,
        name: repo,
        fullName: `${owner}/${repo}`,
      },
    };
  }

  /**
   * Map comments from gh issue list format
   */
  private mapComments(comments: GitHubIssue["comments"]): IssueComment[] {
    return comments.map((c) => ({
      id: c.id,
      author: c.author.login,
      body: c.body,
      createdAt: new Date(c.createdAt),
    }));
  }

  /**
   * Execute gh CLI command
   */
  private async gh(args: string[]): Promise<string> {
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
          reject(new Error(`gh ${args.join(" ")} failed: ${stderr}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn gh: ${err.message}`));
      });
    });
  }
}
