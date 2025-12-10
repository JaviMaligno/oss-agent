/**
 * Pull Request types for feedback loop handling
 */

export type PRState = "open" | "closed" | "merged" | "draft";

export type ReviewState = "pending" | "approved" | "changes_requested" | "commented" | "dismissed";

export type CheckStatus = "pending" | "success" | "failure" | "cancelled" | "skipped";

export interface PullRequest {
  /** Unique identifier (owner/repo#number) */
  id: string;
  /** GitHub PR URL */
  url: string;
  /** PR number */
  number: number;
  /** PR title */
  title: string;
  /** PR body/description */
  body: string;
  /** Current state */
  state: PRState;
  /** Whether PR is a draft */
  isDraft: boolean;
  /** Whether PR is mergeable */
  mergeable: boolean | null;
  /** Source branch */
  headBranch: string;
  /** Target branch */
  baseBranch: string;
  /** Head commit SHA */
  headSha: string;
  /** PR author */
  author: string;
  /** Creation timestamp */
  createdAt: Date;
  /** Last update timestamp */
  updatedAt: Date;
  /** Associated issue URL (if linked) */
  linkedIssueUrl: string | null;
  /** Number of comments */
  commentCount: number;
  /** Number of review comments */
  reviewCommentCount: number;
  /** Whether all checks have passed */
  checksPass: boolean | null;
}

export interface PRReview {
  /** Review ID */
  id: string;
  /** PR this review belongs to */
  prId: string;
  /** Review state */
  state: ReviewState;
  /** Review author */
  author: string;
  /** Review body (if any) */
  body: string | null;
  /** Submission timestamp */
  submittedAt: Date;
  /** Commit SHA this review was made on */
  commitSha: string;
}

export interface PRComment {
  /** Comment ID */
  id: string;
  /** PR this comment belongs to */
  prId: string;
  /** Comment author */
  author: string;
  /** Comment body */
  body: string;
  /** Creation timestamp */
  createdAt: Date;
  /** Last update timestamp */
  updatedAt: Date;
  /** Whether this is a review comment (inline) vs general comment */
  isReviewComment: boolean;
  /** File path (for inline comments) */
  path: string | null;
  /** Line number (for inline comments) */
  line: number | null;
  /** Diff side (for inline comments) */
  side: "LEFT" | "RIGHT" | null;
  /** Original line (for multi-line comments) */
  originalLine: number | null;
  /** Parent comment ID (for replies) */
  inReplyToId: string | null;
}

export interface PRCheck {
  /** Check run ID */
  id: string;
  /** Check name */
  name: string;
  /** Check status */
  status: CheckStatus;
  /** Check conclusion (if completed) */
  conclusion: string | null;
  /** Details URL */
  detailsUrl: string | null;
  /** Started timestamp */
  startedAt: Date | null;
  /** Completed timestamp */
  completedAt: Date | null;
  /** Output summary */
  outputSummary: string | null;
  /** Output text */
  outputText: string | null;
}

/**
 * Actionable feedback extracted from reviews/comments
 */
export interface ActionableFeedback {
  /** Unique ID for this feedback item */
  id: string;
  /** Source type */
  source: "review" | "comment" | "check";
  /** Source ID (review/comment/check ID) */
  sourceId: string;
  /** Feedback type */
  type: FeedbackType;
  /** Priority (1 = highest) */
  priority: number;
  /** Human-readable description */
  description: string;
  /** File path if applicable */
  filePath: string | null;
  /** Line number if applicable */
  lineNumber: number | null;
  /** Raw content that generated this feedback */
  rawContent: string;
  /** Author who provided feedback */
  author: string;
  /** Whether this feedback has been addressed */
  addressed: boolean;
  /** Timestamp */
  createdAt: Date;
}

export type FeedbackType =
  | "code_change" // Specific code modification requested
  | "bug_fix" // Bug identified that needs fixing
  | "style" // Code style/formatting issue
  | "naming" // Variable/function naming suggestion
  | "logic" // Logic/algorithm improvement
  | "test" // Test-related feedback
  | "documentation" // Documentation update needed
  | "performance" // Performance concern
  | "security" // Security issue
  | "ci_failure" // CI check failure
  | "general" // General feedback
  | "question"; // Question that needs response

/**
 * Result of parsing PR feedback
 */
export interface FeedbackParseResult {
  /** PR data */
  pr: PullRequest;
  /** All reviews */
  reviews: PRReview[];
  /** All comments */
  comments: PRComment[];
  /** CI check status */
  checks: PRCheck[];
  /** Extracted actionable items */
  actionableItems: ActionableFeedback[];
  /** Whether PR needs attention */
  needsAttention: boolean;
  /** Summary of what needs to be done */
  summary: string;
}

/**
 * Iteration result after addressing feedback
 */
export interface IterationResult {
  /** Whether iteration was successful */
  success: boolean;
  /** Feedback items that were addressed */
  addressedItems: string[];
  /** Feedback items that couldn't be addressed */
  failedItems: string[];
  /** New commit SHA (if changes were pushed) */
  newCommitSha: string | null;
  /** Number of files changed */
  filesChanged: number;
  /** Iteration metrics */
  metrics: {
    turns: number;
    durationMs: number;
    costUsd: number;
  };
  /** Error message if failed */
  error?: string;
}
