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
  /** Include issues that are assigned to someone (default: false) */
  includeAssigned?: boolean | undefined;
}

export interface IssueScore {
  total: number;
  breakdown: {
    /** Score based on issue description quality (0-20) */
    complexity: number;
    /** Score based on comment activity (0-20) */
    engagement: number;
    /** Score based on issue age (0-25) */
    recency: number;
    /** Score based on helpful labels (can be negative for complex labels) (-15 to 25) */
    labels: number;
    /** Score based on title quality (0-15) */
    clarity: number;
    /** Score based on code references and scope indicators (-20 to 15) */
    codeScope: number;
    /** Score based on reproduction steps and structure (0-20) */
    actionability: number;
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
      includeAssigned: config?.includeAssigned ?? false,
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
   * Higher scores indicate better candidates for automated contribution
   */
  scoreIssue(issue: GitHubIssueInfo): IssueScore {
    const breakdown = {
      complexity: 0,
      engagement: 0,
      recency: 0,
      labels: 0,
      clarity: 0,
      codeScope: 0,
      actionability: 0,
    };

    const body = issue.body ?? "";
    const bodyLower = body.toLowerCase();

    // === Complexity scoring (prefer well-described issues) ===
    const bodyLength = body.length;
    if (bodyLength > 100 && bodyLength < 2000) {
      breakdown.complexity += 20; // Well-described but not overwhelming
    } else if (bodyLength >= 2000) {
      breakdown.complexity += 10; // Very detailed, might be complex
    } else {
      breakdown.complexity += 5; // Too short, unclear
    }

    // === Engagement scoring (some engagement is good, too much might be contentious) ===
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

    // === Recency scoring (prefer newer issues) ===
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

    // === Label scoring (positive for beginner-friendly, negative for complex) ===
    const goodLabels = [
      "good first issue",
      "good-first-issue",
      "help wanted",
      "help-wanted",
      "beginner",
      "easy",
      "starter",
      "low-hanging-fruit",
    ];
    const hasGoodLabel = issue.labels.some((l) =>
      goodLabels.some((gl) => l.toLowerCase().includes(gl.toLowerCase().replace(" ", "-")))
    );
    if (hasGoodLabel) {
      breakdown.labels += 25;
    }

    // Enhancement/feature labels are usually easier than bugs
    if (
      issue.labels.some(
        (l) => l.toLowerCase().includes("enhancement") || l.toLowerCase().includes("feature")
      )
    ) {
      breakdown.labels += 5;
    }

    // Bug labels with clear reproduction are good
    if (issue.labels.some((l) => l.toLowerCase().includes("bug"))) {
      breakdown.labels += 3;
    }

    // Complex/risky labels (negative scoring)
    const complexLabels = [
      "breaking",
      "breaking-change",
      "refactor",
      "architecture",
      "security",
      "performance",
      "critical",
      "complex",
      "major",
    ];
    const hasComplexLabel = issue.labels.some((l) =>
      complexLabels.some((cl) => l.toLowerCase().includes(cl))
    );
    if (hasComplexLabel) {
      breakdown.labels -= 15;
    }

    // === Clarity scoring based on title ===
    const titleWords = issue.title.split(/\s+/).length;
    if (titleWords >= 5 && titleWords <= 15) {
      breakdown.clarity += 15; // Good descriptive title
    } else if (titleWords >= 3) {
      breakdown.clarity += 10;
    } else {
      breakdown.clarity += 5; // Too short, unclear
    }

    // === Code scope scoring (estimate how many files/areas affected) ===
    // Count file path references (e.g., src/foo/bar.ts, ./components/Button.jsx)
    const filePathPattern = /(?:^|[\s`'"])([a-zA-Z0-9_.\-/]+\.[a-zA-Z]{1,5})(?:[\s`'":,]|$)/g;
    const filePaths = body.match(filePathPattern) ?? [];
    const uniqueFilePaths = new Set(filePaths.map((p) => p.trim()));

    if (uniqueFilePaths.size === 0) {
      breakdown.codeScope += 10; // No specific files, might be simple or unclear
    } else if (uniqueFilePaths.size === 1) {
      breakdown.codeScope += 15; // Single file change - ideal
    } else if (uniqueFilePaths.size <= 3) {
      breakdown.codeScope += 5; // Few files - manageable
    } else {
      breakdown.codeScope -= 10; // Many files - complex scope
    }

    // Check for cross-cutting concerns (negative)
    const crossCuttingPatterns = [
      /multiple (files|components|modules)/i,
      /across the codebase/i,
      /refactor(ing)?\s+(the|all|entire)/i,
      /breaking change/i,
      /migration/i,
    ];
    const hasCrossCutting = crossCuttingPatterns.some((p) => p.test(body));
    if (hasCrossCutting) {
      breakdown.codeScope -= 10;
    }

    // === Actionability scoring (reproduction steps, structure, proposed solutions) ===
    // Check for reproduction steps
    const hasReproSteps =
      /steps to reproduce/i.test(body) ||
      /how to reproduce/i.test(body) ||
      /reproduction/i.test(body) ||
      /\n\s*\d+\.\s+/g.test(body); // Numbered list

    if (hasReproSteps) {
      breakdown.actionability += 8;
    }

    // Check for expected vs actual behavior
    const hasExpectedActual =
      (/expected/i.test(body) && /actual/i.test(body)) ||
      /should\s+(be|return|show|display)/i.test(body);
    if (hasExpectedActual) {
      breakdown.actionability += 5;
    }

    // Check for code blocks (shows concrete examples)
    const codeBlockCount = (body.match(/```/g) ?? []).length / 2;
    if (codeBlockCount >= 1 && codeBlockCount <= 3) {
      breakdown.actionability += 5; // Has code examples
    } else if (codeBlockCount > 3) {
      breakdown.actionability += 2; // Too many might be overwhelming
    }

    // Check for proposed solutions or hints
    const hasSolutionHint =
      /possible (fix|solution)/i.test(body) ||
      /could (be fixed|try)/i.test(body) ||
      /suggestion:/i.test(body) ||
      /workaround/i.test(body) ||
      bodyLower.includes("i think the fix") ||
      bodyLower.includes("the issue is in");
    if (hasSolutionHint) {
      breakdown.actionability += 7;
    }

    // Check for markdown structure (headers indicate organized issue)
    const hasHeaders = /^#+\s+/m.test(body);
    if (hasHeaders) {
      breakdown.actionability += 3;
    }

    // Check for stack traces or error messages (helpful for debugging)
    const hasErrorInfo =
      /error:/i.test(body) ||
      /exception/i.test(body) ||
      /stack\s*trace/i.test(body) ||
      /at\s+[\w.]+\s+\([^)]+:\d+:\d+\)/i.test(body); // Stack trace pattern
    if (hasErrorInfo) {
      breakdown.actionability += 2;
    }

    // === Calculate total ===
    const total =
      breakdown.complexity +
      breakdown.engagement +
      breakdown.recency +
      breakdown.labels +
      breakdown.clarity +
      breakdown.codeScope +
      breakdown.actionability;

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

    // Exclude assigned issues (unless includeAssigned is true)
    if (!config.includeAssigned) {
      filtered = filtered.filter((issue) => issue.assignees.length === 0);
    }

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
