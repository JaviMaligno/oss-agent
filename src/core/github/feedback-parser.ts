/**
 * Feedback Parser - Extracts actionable feedback from PR reviews and comments
 */

import { randomUUID } from "node:crypto";
import {
  PullRequest,
  PRReview,
  PRComment,
  PRCheck,
  ActionableFeedback,
  FeedbackType,
  FeedbackParseResult,
} from "../../types/pr.js";

export interface FeedbackParserOptions {
  /** Authors to ignore (e.g., bots) */
  ignoreAuthors?: string[];
  /** Include pending reviews */
  includePendingReviews?: boolean;
}

/**
 * Patterns for detecting feedback types
 */
const FEEDBACK_PATTERNS: Array<{ type: FeedbackType; patterns: RegExp[]; priority: number }> = [
  {
    type: "security",
    patterns: [
      /security\s*(issue|vulnerability|concern|risk)/i,
      /\b(XSS|CSRF|SQL\s*injection|injection\s*attack)/i,
      /\b(unsafe|dangerous)\b.*\b(input|data|code)/i,
      /\bsanitize\b/i,
      /\bescape\b.*\b(html|input|user)/i,
    ],
    priority: 1,
  },
  {
    type: "bug_fix",
    patterns: [
      /\bbug\b/i,
      /\bbroken\b/i,
      /\bdoesn'?t\s+work\b/i,
      /\bfails?\b.*\b(when|if|on)\b/i,
      /\bcrash(es|ing)?\b/i,
      /\berror\b.*\b(occurs?|happens?|thrown)\b/i,
      /\bnull\s*pointer\b/i,
      /\bundefined\b.*\b(is\s+not|error)\b/i,
    ],
    priority: 2,
  },
  {
    type: "ci_failure",
    patterns: [
      /\bCI\b.*\b(fail|broke|error)/i,
      /\btest(s)?\s+(fail|broke)/i,
      /\bbuild\s+(fail|broke|error)/i,
      /\blint(ing)?\s+(error|fail)/i,
      /\btype\s*(check|error)/i,
    ],
    priority: 2,
  },
  {
    type: "code_change",
    patterns: [
      /\bchange\s+(this|that|the)\b/i,
      /\breplace\s+(this|that|with)\b/i,
      /\bmodify\b/i,
      /\bupdate\s+(this|the)\b/i,
      /\brefactor\b/i,
      /\bplease\s+(use|add|remove|change)/i,
      /\bshould\s+(be|use|have)\b/i,
      /\binstead\s+of\b/i,
      /\brather\s+than\b/i,
    ],
    priority: 3,
  },
  {
    type: "logic",
    patterns: [
      /\blogic\b/i,
      /\balgorithm\b/i,
      /\bedge\s*case\b/i,
      /\bcorner\s*case\b/i,
      /\bhandle\s+(the\s+)?case\b/i,
      /\bwhat\s+(if|about|happens)\b/i,
    ],
    priority: 3,
  },
  {
    type: "performance",
    patterns: [
      /\bperformance\b/i,
      /\bslow\b/i,
      /\boptimize\b/i,
      /\befficiency\b/i,
      /\bO\(n\^?\d?\)/i,
      /\bmemory\s*(leak|usage)\b/i,
    ],
    priority: 3,
  },
  {
    type: "test",
    patterns: [
      /\badd\s+(a\s+)?test/i,
      /\btest\s+(coverage|case|this)/i,
      /\bmissing\s+test/i,
      /\bunit\s+test/i,
      /\bintegration\s+test/i,
    ],
    priority: 4,
  },
  {
    type: "naming",
    patterns: [
      /\brename\b/i,
      /\bname\s+(should|could|is)/i,
      /\bbetter\s+name\b/i,
      /\bconfusing\s+name\b/i,
      /\bvariable\s+name\b/i,
      /\bfunction\s+name\b/i,
    ],
    priority: 4,
  },
  {
    type: "style",
    patterns: [
      /\bstyle\b/i,
      /\bformat(ting)?\b/i,
      /\bindentation\b/i,
      /\bwhitespace\b/i,
      /\bconsistent\b/i,
      /\bconvention\b/i,
    ],
    priority: 5,
  },
  {
    type: "documentation",
    patterns: [
      /\bdoc(s|umentation)?\b/i,
      /\bcomment\b.*\b(add|missing|update)/i,
      /\bexplain\b/i,
      /\bREADME\b/i,
      /\bJSDoc\b/i,
      /\btypedoc\b/i,
    ],
    priority: 5,
  },
  {
    type: "question",
    patterns: [
      /^(why|what|how|when|where|could you|can you)\b/i,
      /\?$/,
      /\bi'?m\s+(not\s+sure|confused)/i,
      /\bcan\s+you\s+explain\b/i,
    ],
    priority: 6,
  },
];

/**
 * Words/phrases that indicate the comment is NOT actionable
 */
const NON_ACTIONABLE_PATTERNS = [
  /^(LGTM|looks\s+good|nice|great|awesome|perfect|ship\s+it)/i,
  /^(thanks|thank\s+you|ty)/i,
  /^\+1$/,
  /^(approved|approving)/i,
  /^(nit|nitpick|minor|optional):/i,
];

export class FeedbackParser {
  private options: Required<FeedbackParserOptions>;

  constructor(options: FeedbackParserOptions = {}) {
    this.options = {
      ignoreAuthors: options.ignoreAuthors ?? ["dependabot[bot]", "github-actions[bot]"],
      includePendingReviews: options.includePendingReviews ?? false,
    };
  }

  /**
   * Parse all feedback from PR data and extract actionable items
   */
  parse(
    pr: PullRequest,
    reviews: PRReview[],
    comments: PRComment[],
    checks: PRCheck[]
  ): FeedbackParseResult {
    const actionableItems: ActionableFeedback[] = [];

    // Process reviews
    for (const review of reviews) {
      if (this.shouldIgnoreAuthor(review.author)) continue;
      if (!this.options.includePendingReviews && review.state === "pending") continue;

      // Changes requested reviews are high priority
      if (review.state === "changes_requested" && review.body) {
        const items = this.extractFeedbackFromText(
          review.body,
          "review",
          review.id,
          review.author,
          review.submittedAt
        );
        // Boost priority for changes_requested
        for (const item of items) {
          item.priority = Math.max(1, item.priority - 1);
        }
        actionableItems.push(...items);
      } else if (review.state === "commented" && review.body) {
        const items = this.extractFeedbackFromText(
          review.body,
          "review",
          review.id,
          review.author,
          review.submittedAt
        );
        actionableItems.push(...items);
      }
    }

    // Process comments
    for (const comment of comments) {
      if (this.shouldIgnoreAuthor(comment.author)) continue;
      // Skip reply comments - they're usually discussions
      if (comment.inReplyToId) continue;

      const items = this.extractFeedbackFromText(
        comment.body,
        "comment",
        comment.id,
        comment.author,
        comment.createdAt,
        comment.path,
        comment.line
      );
      actionableItems.push(...items);
    }

    // Process failed checks
    for (const check of checks) {
      if (check.status === "failure") {
        actionableItems.push({
          id: randomUUID(),
          source: "check",
          sourceId: check.id,
          type: "ci_failure",
          priority: 1, // High priority - blocks merge
          description: `CI check "${check.name}" failed`,
          filePath: null,
          lineNumber: null,
          rawContent: check.outputSummary ?? check.outputText ?? `${check.name} failed`,
          author: "CI",
          addressed: false,
          createdAt: check.completedAt ?? new Date(),
        });
      }
    }

    // Sort by priority
    actionableItems.sort((a, b) => a.priority - b.priority);

    // Determine if PR needs attention
    const hasChangesRequested = reviews.some((r) => r.state === "changes_requested");
    const hasFailedChecks = checks.some((c) => c.status === "failure");
    const hasActionableItems = actionableItems.length > 0;
    const needsAttention = hasChangesRequested || hasFailedChecks || hasActionableItems;

    // Build summary
    const summary = this.buildSummary(pr, reviews, comments, checks, actionableItems);

    return {
      pr,
      reviews,
      comments,
      checks,
      actionableItems,
      needsAttention,
      summary,
    };
  }

  /**
   * Extract feedback items from text content
   */
  private extractFeedbackFromText(
    text: string,
    source: "review" | "comment",
    sourceId: string,
    author: string,
    createdAt: Date,
    filePath: string | null = null,
    lineNumber: number | null = null
  ): ActionableFeedback[] {
    const items: ActionableFeedback[] = [];

    // Skip if text matches non-actionable patterns
    if (NON_ACTIONABLE_PATTERNS.some((pattern) => pattern.test(text.trim()))) {
      return items;
    }

    // Detect feedback type and priority
    const { type, priority } = this.detectFeedbackType(text);

    // Only create actionable item if we detected a specific type or it's substantial
    if (type !== "general" || text.length > 50) {
      items.push({
        id: randomUUID(),
        source,
        sourceId,
        type,
        priority,
        description: this.summarizeText(text),
        filePath,
        lineNumber,
        rawContent: text,
        author,
        addressed: false,
        createdAt,
      });
    }

    return items;
  }

  /**
   * Detect the type and priority of feedback from text
   */
  private detectFeedbackType(text: string): { type: FeedbackType; priority: number } {
    for (const { type, patterns, priority } of FEEDBACK_PATTERNS) {
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          return { type, priority };
        }
      }
    }
    return { type: "general", priority: 5 };
  }

  /**
   * Create a short summary of feedback text
   */
  private summarizeText(text: string): string {
    // Take first sentence or first 100 chars
    const firstSentence = text.split(/[.!?\n]/)[0] ?? text;
    if (firstSentence.length <= 100) {
      return firstSentence.trim();
    }
    return firstSentence.substring(0, 97).trim() + "...";
  }

  /**
   * Check if author should be ignored
   */
  private shouldIgnoreAuthor(author: string): boolean {
    return this.options.ignoreAuthors.includes(author);
  }

  /**
   * Build a human-readable summary of PR feedback
   */
  private buildSummary(
    pr: PullRequest,
    reviews: PRReview[],
    _comments: PRComment[],
    checks: PRCheck[],
    actionableItems: ActionableFeedback[]
  ): string {
    const parts: string[] = [];

    // PR state
    parts.push(`PR #${pr.number} is ${pr.state}${pr.isDraft ? " (draft)" : ""}`);

    // Review status
    const approved = reviews.filter((r) => r.state === "approved").length;
    const changesRequested = reviews.filter((r) => r.state === "changes_requested").length;
    if (changesRequested > 0) {
      parts.push(`${changesRequested} reviewer(s) requested changes`);
    } else if (approved > 0) {
      parts.push(`${approved} approval(s)`);
    }

    // Check status
    const failedChecks = checks.filter((c) => c.status === "failure");
    const pendingChecks = checks.filter((c) => c.status === "pending");
    if (failedChecks.length > 0) {
      parts.push(
        `${failedChecks.length} check(s) failed: ${failedChecks.map((c) => c.name).join(", ")}`
      );
    } else if (pendingChecks.length > 0) {
      parts.push(`${pendingChecks.length} check(s) pending`);
    } else if (checks.length > 0) {
      parts.push("All checks passed");
    }

    // Actionable items
    if (actionableItems.length > 0) {
      const byType = new Map<FeedbackType, number>();
      for (const item of actionableItems) {
        byType.set(item.type, (byType.get(item.type) ?? 0) + 1);
      }
      const typeSummary = Array.from(byType.entries())
        .map(([type, count]) => `${count} ${type}`)
        .join(", ");
      parts.push(`${actionableItems.length} actionable item(s): ${typeSummary}`);
    } else {
      parts.push("No actionable feedback");
    }

    // Mergeable status
    if (pr.mergeable === true) {
      parts.push("Ready to merge");
    } else if (pr.mergeable === false) {
      parts.push("Has merge conflicts");
    }

    return parts.join(". ") + ".";
  }

  /**
   * Group feedback items by file
   */
  groupByFile(items: ActionableFeedback[]): Map<string | null, ActionableFeedback[]> {
    const byFile = new Map<string | null, ActionableFeedback[]>();

    for (const item of items) {
      const key = item.filePath;
      const existing = byFile.get(key) ?? [];
      existing.push(item);
      byFile.set(key, existing);
    }

    return byFile;
  }

  /**
   * Format feedback for AI prompt
   */
  formatForPrompt(items: ActionableFeedback[]): string {
    if (items.length === 0) {
      return "No actionable feedback items.";
    }

    const lines: string[] = ["## Feedback to Address\n"];

    const byFile = this.groupByFile(items);

    // First, file-specific feedback
    for (const [filePath, fileItems] of byFile) {
      if (filePath) {
        lines.push(`### ${filePath}\n`);
        for (const item of fileItems) {
          const lineInfo = item.lineNumber ? ` (line ${item.lineNumber})` : "";
          lines.push(`- **[${item.type}]**${lineInfo} ${item.description}`);
          if (item.rawContent.length > item.description.length) {
            lines.push(`  > ${item.rawContent.split("\n")[0]}`);
          }
        }
        lines.push("");
      }
    }

    // Then, general feedback
    const generalItems = byFile.get(null) ?? [];
    if (generalItems.length > 0) {
      lines.push("### General Feedback\n");
      for (const item of generalItems) {
        lines.push(`- **[${item.type}]** ${item.description}`);
        if (item.rawContent.length > item.description.length) {
          lines.push(`  > ${item.rawContent.split("\n")[0]}`);
        }
      }
    }

    return lines.join("\n");
  }
}
