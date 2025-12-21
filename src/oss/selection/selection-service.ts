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
  /** Sort by "score" (legacy) or "roi" (new). Default: "score" */
  sortBy?: "score" | "roi" | undefined;
}

/**
 * ROI-based issue scoring model
 *
 * ROI = (Feasibility × Impact) / Cost
 *
 * Higher ROI = better candidate for automated contribution
 */
export interface IssueROI {
  /** Final ROI score (0-100, higher = better investment) */
  roi: number;

  /** Probability of successfully solving this issue (0-100) */
  feasibility: {
    /** Total feasibility score */
    total: number;
    /** Issue is well-documented with clear description (0-25) */
    clarity: number;
    /** Limited scope - few files/components affected (0-25) */
    scope: number;
    /** Has reproduction steps, code examples, structure (0-25) */
    actionability: number;
    /** Has solution hints or maintainer guidance (0-25) */
    guidance: number;
  };

  /** Value/importance of solving this issue (0-100) */
  impact: {
    /** Total impact score */
    total: number;
    /** Repository popularity - stars, activity (0-35) */
    repoPopularity: number;
    /** Label importance - bug > feature > docs (0-30) */
    labelImportance: number;
    /** Issue freshness - newer issues more relevant (0-20) */
    freshness: number;
    /** Community interest - reactions, watchers (0-15) */
    communityInterest: number;
  };

  /** Estimated effort/risk (0-100, lower = better) */
  cost: {
    /** Total cost score (inverted for ROI calculation) */
    total: number;
    /** Estimated number of files to modify (0-30) */
    estimatedScope: number;
    /** Complexity indicators in description (0-30) */
    complexitySignals: number;
    /** Risky labels - breaking, security, etc (0-25) */
    riskLabels: number;
    /** Contentious discussion or many failed attempts (0-15) */
    contention: number;
  };
}

/** Context for scoring - optional repo stats for impact calculation */
export interface ScoringContext {
  /** Repository stars */
  stars?: number;
  /** Repository forks */
  forks?: number;
  /** Is repo actively maintained */
  isActive?: boolean;
}

// Keep old interface for backwards compatibility
export interface IssueScore {
  total: number;
  breakdown: {
    complexity: number;
    engagement: number;
    recency: number;
    labels: number;
    clarity: number;
    codeScope: number;
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
      sortBy: config?.sortBy ?? "score",
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

      // Sort by score or ROI
      if (effectiveConfig.sortBy === "roi") {
        // Use ROI scoring with project context
        const context: ScoringContext = {
          stars: project.stars,
          forks: project.forks,
        };
        const scored = filtered.map((issue) => ({
          issue,
          roi: this.calculateROI(issue, context),
        }));

        return scored
          .sort((a, b) => b.roi.roi - a.roi.roi)
          .slice(0, effectiveConfig.limit)
          .map((s) => s.issue);
      } else {
        // Use legacy score
        const scored = filtered.map((issue) => ({
          issue,
          score: this.scoreIssue(issue),
        }));

        return scored
          .sort((a, b) => b.score.total - a.score.total)
          .slice(0, effectiveConfig.limit)
          .map((s) => s.issue);
      }
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
   * Calculate ROI (Return on Investment) for an issue
   *
   * ROI = (Feasibility × Impact) / Cost
   *
   * @param issue - The issue to score
   * @param context - Optional context with repo stats for better impact scoring
   */
  calculateROI(issue: GitHubIssueInfo, context?: ScoringContext): IssueROI {
    const body = issue.body ?? "";
    const bodyLower = body.toLowerCase();
    const comments = issue.comments ?? [];

    // ============================================
    // FEASIBILITY (0-100): Can we solve this?
    // ============================================
    const feasibility = {
      total: 0,
      clarity: 0,
      scope: 0,
      actionability: 0,
      guidance: 0,
    };

    // --- Clarity (0-25): Is the issue well-documented? ---
    const bodyLength = body.length;
    if (bodyLength >= 200 && bodyLength < 2000) {
      feasibility.clarity = 25; // Well-described
    } else if (bodyLength >= 100 && bodyLength < 200) {
      feasibility.clarity = 18;
    } else if (bodyLength >= 2000 && bodyLength < 5000) {
      feasibility.clarity = 15; // Detailed but long
    } else if (bodyLength >= 5000) {
      feasibility.clarity = 8; // Very long, potentially complex
    } else {
      feasibility.clarity = 5; // Too short
    }

    // Title quality bonus
    const titleWords = issue.title.split(/\s+/).length;
    if (titleWords >= 5 && titleWords <= 12) {
      feasibility.clarity = Math.min(25, feasibility.clarity + 5);
    }

    // --- Scope (0-25): How focused is the change? ---
    // Count file path references
    const filePathPattern = /(?:^|[\s`'"])([a-zA-Z0-9_.\-/]+\.[a-zA-Z]{1,5})(?:[\s`'":,]|$)/g;
    const filePaths = body.match(filePathPattern) ?? [];
    const uniqueFilePaths = new Set(filePaths.map((p) => p.trim()));

    if (uniqueFilePaths.size === 0) {
      feasibility.scope = 15; // Unknown scope - assume moderate
    } else if (uniqueFilePaths.size === 1) {
      feasibility.scope = 25; // Single file - ideal
    } else if (uniqueFilePaths.size <= 3) {
      feasibility.scope = 20; // Few files - good
    } else if (uniqueFilePaths.size <= 5) {
      feasibility.scope = 10; // Several files
    } else {
      feasibility.scope = 3; // Many files - complex
    }

    // Penalize cross-cutting changes
    const crossCuttingPatterns = [
      /multiple (files|components|modules|packages)/i,
      /across the codebase/i,
      /refactor(ing)?\s+(the|all|entire)/i,
      /migration/i,
      /throughout/i,
    ];
    if (crossCuttingPatterns.some((p) => p.test(body))) {
      feasibility.scope = Math.max(0, feasibility.scope - 10);
    }

    // --- Actionability (0-25): Can we act on this? ---
    // Reproduction steps
    if (
      /steps to reproduce/i.test(body) ||
      /how to reproduce/i.test(body) ||
      /reproduction/i.test(body)
    ) {
      feasibility.actionability += 8;
    }

    // Numbered lists (structured info)
    if (/\n\s*\d+\.\s+/g.test(body)) {
      feasibility.actionability += 4;
    }

    // Expected vs actual behavior
    if (
      (/expected/i.test(body) && /actual/i.test(body)) ||
      /should\s+(be|return|show|display)/i.test(body)
    ) {
      feasibility.actionability += 5;
    }

    // Code blocks
    const codeBlockCount = (body.match(/```/g) ?? []).length / 2;
    if (codeBlockCount >= 1 && codeBlockCount <= 3) {
      feasibility.actionability += 5;
    } else if (codeBlockCount > 0) {
      feasibility.actionability += 2;
    }

    // Error messages / stack traces
    if (
      /error:/i.test(body) ||
      /exception/i.test(body) ||
      /at\s+[\w.]+\s+\([^)]+:\d+:\d+\)/i.test(body)
    ) {
      feasibility.actionability += 3;
    }

    feasibility.actionability = Math.min(25, feasibility.actionability);

    // --- Guidance (0-25): Is there help available? ---
    // Solution hints in issue body
    if (
      /possible (fix|solution)/i.test(body) ||
      /could (be fixed|try)/i.test(body) ||
      /suggestion:/i.test(body) ||
      bodyLower.includes("i think the fix") ||
      bodyLower.includes("the issue is in") ||
      bodyLower.includes("the problem is")
    ) {
      feasibility.guidance += 10;
    }

    // Workaround mentioned
    if (/workaround/i.test(body)) {
      feasibility.guidance += 5;
    }

    // Maintainer comments with guidance
    const maintainerKeywords = ["you could", "try ", "the fix", "look at", "check ", "should be"];
    for (const comment of comments) {
      if (maintainerKeywords.some((k) => comment.body.toLowerCase().includes(k))) {
        feasibility.guidance += 5;
        break;
      }
    }

    // Markdown structure (organized issue)
    if (/^#+\s+/m.test(body)) {
      feasibility.guidance += 5;
    }

    feasibility.guidance = Math.min(25, feasibility.guidance);
    feasibility.total =
      feasibility.clarity + feasibility.scope + feasibility.actionability + feasibility.guidance;

    // ============================================
    // IMPACT (0-100): How valuable is solving this?
    // ============================================
    const impact = {
      total: 0,
      repoPopularity: 0,
      labelImportance: 0,
      freshness: 0,
      communityInterest: 0,
    };

    // --- Repo Popularity (0-35): How popular is the repo? ---
    if (context?.stars !== undefined) {
      if (context.stars >= 10000) {
        impact.repoPopularity = 35;
      } else if (context.stars >= 5000) {
        impact.repoPopularity = 30;
      } else if (context.stars >= 1000) {
        impact.repoPopularity = 25;
      } else if (context.stars >= 500) {
        impact.repoPopularity = 20;
      } else if (context.stars >= 100) {
        impact.repoPopularity = 15;
      } else {
        impact.repoPopularity = 10;
      }
    } else {
      // Default when no context - assume moderate popularity
      impact.repoPopularity = 20;
    }

    // --- Label Importance (0-30): How important is this type of issue? ---
    const labels = issue.labels.map((l) => l.toLowerCase());

    // High value labels
    if (labels.some((l) => l.includes("bug") || l.includes("defect"))) {
      impact.labelImportance += 20; // Bugs are high value
    }
    if (labels.some((l) => l.includes("regression"))) {
      impact.labelImportance += 25; // Regressions are very high value
    }
    if (
      labels.some(
        (l) => l.includes("good first issue") || l.includes("help wanted") || l.includes("beginner")
      )
    ) {
      impact.labelImportance += 15; // Explicitly wanted
    }
    if (labels.some((l) => l.includes("enhancement") || l.includes("feature"))) {
      impact.labelImportance += 10;
    }
    if (labels.some((l) => l.includes("documentation") || l.includes("docs"))) {
      impact.labelImportance += 5;
    }

    impact.labelImportance = Math.min(30, impact.labelImportance);

    // --- Freshness (0-20): How recent is the issue? ---
    const daysSinceCreated = Math.floor(
      (Date.now() - issue.createdAt.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (daysSinceCreated < 7) {
      impact.freshness = 20;
    } else if (daysSinceCreated < 14) {
      impact.freshness = 18;
    } else if (daysSinceCreated < 30) {
      impact.freshness = 15;
    } else if (daysSinceCreated < 90) {
      impact.freshness = 10;
    } else if (daysSinceCreated < 180) {
      impact.freshness = 5;
    } else {
      impact.freshness = 2; // Very old issues
    }

    // --- Community Interest (0-15): Is there interest? ---
    // Comment count as proxy for interest
    const commentCount = comments.length;
    if (commentCount >= 1 && commentCount <= 5) {
      impact.communityInterest = 15; // Active discussion
    } else if (commentCount > 5 && commentCount <= 10) {
      impact.communityInterest = 10;
    } else if (commentCount > 10) {
      impact.communityInterest = 5; // Too much might be contentious
    } else {
      impact.communityInterest = 8; // No comments yet
    }

    impact.total =
      impact.repoPopularity + impact.labelImportance + impact.freshness + impact.communityInterest;

    // ============================================
    // COST (0-100): How much effort/risk?
    // ============================================
    const cost = {
      total: 0,
      estimatedScope: 0,
      complexitySignals: 0,
      riskLabels: 0,
      contention: 0,
    };

    // --- Estimated Scope (0-30): How many files to change? ---
    if (uniqueFilePaths.size === 0) {
      cost.estimatedScope = 15; // Unknown
    } else if (uniqueFilePaths.size === 1) {
      cost.estimatedScope = 5;
    } else if (uniqueFilePaths.size <= 3) {
      cost.estimatedScope = 12;
    } else if (uniqueFilePaths.size <= 5) {
      cost.estimatedScope = 20;
    } else {
      cost.estimatedScope = 30;
    }

    // Cross-cutting increases cost
    if (crossCuttingPatterns.some((p) => p.test(body))) {
      cost.estimatedScope = Math.min(30, cost.estimatedScope + 10);
    }

    // --- Complexity Signals (0-30): Does description indicate complexity? ---
    const complexityIndicators = [
      { pattern: /breaking change/i, weight: 15 },
      { pattern: /backwards? compatib/i, weight: 10 },
      { pattern: /performance/i, weight: 8 },
      { pattern: /race condition/i, weight: 12 },
      { pattern: /memory leak/i, weight: 10 },
      { pattern: /concurrency/i, weight: 10 },
      { pattern: /async(hronous)?/i, weight: 5 },
      { pattern: /thread[- ]?safe/i, weight: 8 },
      { pattern: /architecture/i, weight: 12 },
      { pattern: /redesign/i, weight: 15 },
    ];

    for (const { pattern, weight } of complexityIndicators) {
      if (pattern.test(body)) {
        cost.complexitySignals += weight;
      }
    }
    cost.complexitySignals = Math.min(30, cost.complexitySignals);

    // --- Risk Labels (0-25): Dangerous labels? ---
    const riskLabelPatterns = [
      { pattern: "breaking", weight: 15 },
      { pattern: "security", weight: 20 },
      { pattern: "critical", weight: 10 },
      { pattern: "major", weight: 8 },
      { pattern: "performance", weight: 5 },
      { pattern: "refactor", weight: 8 },
    ];

    for (const { pattern, weight } of riskLabelPatterns) {
      if (labels.some((l) => l.includes(pattern))) {
        cost.riskLabels += weight;
      }
    }
    cost.riskLabels = Math.min(25, cost.riskLabels);

    // --- Contention (0-15): Is there conflict/failed attempts? ---
    if (commentCount > 15) {
      cost.contention = 15; // Very contentious
    } else if (commentCount > 10) {
      cost.contention = 10;
    } else if (commentCount > 5) {
      cost.contention = 5;
    }

    // Check for signs of failed attempts or disagreement
    const contentionPhrases = [
      "won't fix",
      "wontfix",
      "not a bug",
      "by design",
      "duplicate",
      "already tried",
      "doesn't work",
      "still broken",
    ];
    for (const comment of comments) {
      if (contentionPhrases.some((p) => comment.body.toLowerCase().includes(p))) {
        cost.contention = Math.min(15, cost.contention + 5);
        break;
      }
    }

    cost.total = cost.estimatedScope + cost.complexitySignals + cost.riskLabels + cost.contention;

    // ============================================
    // CALCULATE ROI
    // ============================================
    // ROI = sqrt(Feasibility × Impact) × (100 - Cost) / 100
    //
    // This formula:
    // - Uses geometric mean of F and I (balances both dimensions)
    // - Multiplies by cost factor (high cost reduces ROI proportionally)
    // - Gives better distribution (typically 20-70 range vs everything being 100)
    //
    // Examples:
    // - F=60, I=50, C=20: sqrt(3000) * 0.80 = 54.8 * 0.80 = 43.8
    // - F=80, I=70, C=10: sqrt(5600) * 0.90 = 74.8 * 0.90 = 67.3
    // - F=40, I=40, C=40: sqrt(1600) * 0.60 = 40.0 * 0.60 = 24.0
    const rawROI = (Math.sqrt(feasibility.total * impact.total) * (100 - cost.total)) / 100;
    const roi = Math.max(0, Math.min(100, Math.round(rawROI)));

    return {
      roi,
      feasibility,
      impact,
      cost,
    };
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
