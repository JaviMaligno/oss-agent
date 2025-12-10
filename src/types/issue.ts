export type IssueState =
  | "discovered"
  | "queued"
  | "in_progress"
  | "pr_created"
  | "awaiting_feedback"
  | "iterating"
  | "merged"
  | "closed"
  | "abandoned";

/** Valid state transitions for the issue state machine */
export const VALID_TRANSITIONS: Record<IssueState, IssueState[]> = {
  discovered: ["queued", "abandoned"],
  queued: ["in_progress", "abandoned"],
  in_progress: ["pr_created", "abandoned"],
  pr_created: ["awaiting_feedback", "merged", "closed", "abandoned"],
  awaiting_feedback: ["iterating", "merged", "closed", "abandoned"],
  iterating: ["pr_created", "merged", "closed", "abandoned"],
  merged: [], // Terminal state
  closed: ["queued"], // Can be reopened
  abandoned: ["queued"], // Can be retried
};

/** Terminal states that cannot transition further */
export const TERMINAL_STATES: IssueState[] = ["merged"];

/** States that indicate active work */
export const ACTIVE_STATES: IssueState[] = ["in_progress", "iterating"];

export interface Issue {
  id: string;
  url: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: IssueState;
  author: string;
  assignee: string | null;
  createdAt: Date;
  updatedAt: Date;
  projectId: string;
  hasLinkedPR: boolean;
  linkedPRUrl: string | null;
}

/** Record of an issue state transition */
export interface IssueTransition {
  issueId: string;
  fromState: IssueState;
  toState: IssueState;
  timestamp: Date;
  reason: string;
  sessionId?: string;
}

/** Metadata for tracking issue work */
export interface IssueWorkRecord {
  issueId: string;
  sessionId: string;
  branchName: string;
  worktreePath: string;
  prNumber?: number;
  prUrl?: string;
  attempts: number;
  lastAttemptAt: Date;
  totalCostUsd: number;
}

export interface IssueScore {
  total: number;
  breakdown: {
    labelScore: number;
    ageScore: number;
    clarityScore: number;
    projectHealthScore: number;
    prStatusScore: number;
  };
}
