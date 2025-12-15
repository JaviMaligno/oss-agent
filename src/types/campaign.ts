/**
 * Campaign Types
 *
 * Types for campaign management - batch operations on multiple issues.
 */

import { z } from "zod";

// === Campaign Status ===

export const CampaignStatusSchema = z.enum([
  "draft", // Created but not started
  "active", // Running
  "paused", // Temporarily stopped
  "completed", // All issues processed
  "cancelled", // Stopped before completion
]);

export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

// === Campaign Issue Status ===

export const CampaignIssueStatusSchema = z.enum([
  "pending", // Not yet processed
  "queued", // Queued for processing
  "in_progress", // Currently being worked on
  "completed", // Successfully processed
  "failed", // Processing failed
  "skipped", // Skipped (e.g., conflict, budget)
]);

export type CampaignIssueStatus = z.infer<typeof CampaignIssueStatusSchema>;

// === Campaign Source Type ===

export const CampaignSourceTypeSchema = z.enum([
  "manual", // Manually added issues
  "jira_jql", // Jira JQL query
  "linear_filter", // Linear filter criteria
  "github_search", // GitHub issue search
  "sentry_errors", // Sentry error issues
]);

export type CampaignSourceType = z.infer<typeof CampaignSourceTypeSchema>;

// === Campaign Source Config ===

export const CampaignSourceConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("manual"),
  }),
  z.object({
    type: z.literal("jira_jql"),
    jql: z.string(),
    projectKey: z.string(),
    maxIssues: z.number().optional(),
  }),
  z.object({
    type: z.literal("linear_filter"),
    teamId: z.string(),
    projectId: z.string().optional(),
    stateFilter: z.array(z.string()).optional(),
    labelFilter: z.array(z.string()).optional(),
    maxIssues: z.number().optional(),
  }),
  z.object({
    type: z.literal("github_search"),
    query: z.string(),
    repository: z.string().optional(),
    maxIssues: z.number().optional(),
  }),
  z.object({
    type: z.literal("sentry_errors"),
    projectSlug: z.string(),
    minOccurrences: z.number().optional(),
    maxIssues: z.number().optional(),
  }),
]);

export type CampaignSourceConfig = z.infer<typeof CampaignSourceConfigSchema>;

// === Campaign ===

export interface Campaign {
  /** Unique campaign identifier */
  id: string;
  /** Campaign name */
  name: string;
  /** Optional description */
  description?: string;
  /** Current status */
  status: CampaignStatus;
  /** How issues are sourced */
  sourceType: CampaignSourceType;
  /** Source-specific configuration */
  sourceConfig?: CampaignSourceConfig;
  /** Maximum budget in USD (null = no limit) */
  budgetLimitUsd?: number;
  /** Amount spent so far */
  budgetSpentUsd: number;
  /** Total number of issues in campaign */
  totalIssues: number;
  /** Number of completed issues */
  completedIssues: number;
  /** Number of failed issues */
  failedIssues: number;
  /** Number of skipped issues */
  skippedIssues: number;
  /** Creation timestamp */
  createdAt: string;
  /** When campaign was started */
  startedAt?: string;
  /** When campaign completed or was cancelled */
  completedAt?: string;
  /** Optional tags for organization */
  tags?: string[];
}

// === Campaign Issue ===

export interface CampaignIssue {
  /** Auto-increment ID */
  id: number;
  /** Campaign this issue belongs to */
  campaignId: string;
  /** Issue URL (can be GitHub, Jira, Linear, etc.) */
  issueUrl: string;
  /** External issue ID (e.g., Jira key, Linear identifier) */
  externalIssueId?: string;
  /** Current status in campaign */
  status: CampaignIssueStatus;
  /** Priority within campaign (lower = higher priority) */
  priority: number;
  /** Session ID if work started */
  sessionId?: string;
  /** PR URL if created */
  prUrl?: string;
  /** Cost in USD for this issue */
  costUsd?: number;
  /** When added to campaign */
  addedAt: string;
  /** When processing started */
  startedAt?: string;
  /** When processing completed */
  completedAt?: string;
  /** Error message if failed */
  error?: string;
  /** Number of retry attempts */
  attempts: number;
}

// === Campaign Progress ===

export interface CampaignProgress {
  /** Campaign ID */
  campaignId: string;
  /** Campaign name */
  name: string;
  /** Current status */
  status: CampaignStatus;
  /** Total issues */
  total: number;
  /** Pending issues */
  pending: number;
  /** Queued issues */
  queued: number;
  /** In progress issues */
  inProgress: number;
  /** Completed issues */
  completed: number;
  /** Failed issues */
  failed: number;
  /** Skipped issues */
  skipped: number;
  /** Progress percentage (0-100) */
  progressPercent: number;
  /** Budget spent */
  budgetSpent: number;
  /** Budget limit */
  budgetLimit?: number;
  /** Budget percentage used */
  budgetPercent?: number;
  /** Estimated completion time (if active) */
  estimatedCompletion?: string;
}

// === Campaign Create Options ===

export interface CreateCampaignOptions {
  /** Campaign name */
  name: string;
  /** Optional description */
  description?: string;
  /** How issues are sourced */
  sourceType: CampaignSourceType;
  /** Source-specific configuration */
  sourceConfig?: CampaignSourceConfig;
  /** Maximum budget in USD */
  budgetLimitUsd?: number;
  /** Tags */
  tags?: string[];
}

// === Campaign Update Options ===

export interface UpdateCampaignOptions {
  /** New name */
  name?: string;
  /** New description */
  description?: string;
  /** New budget limit */
  budgetLimitUsd?: number;
  /** New tags */
  tags?: string[];
}

// === Campaign Run Options ===

export interface CampaignRunOptions {
  /** Maximum concurrent issues to work on */
  maxConcurrent?: number;
  /** Stop after N issues */
  maxIssues?: number;
  /** Dry run (don't actually create PRs) */
  dryRun?: boolean;
  /** Skip issues that have been attempted before */
  skipRetries?: boolean;
  /** Continue on error */
  continueOnError?: boolean;
}

// === Campaign Run Result ===

export interface CampaignRunResult {
  /** Campaign ID */
  campaignId: string;
  /** Number of issues processed */
  processed: number;
  /** Number of issues completed successfully */
  completed: number;
  /** Number of issues that failed */
  failed: number;
  /** Number of issues skipped */
  skipped: number;
  /** Total cost */
  totalCost: number;
  /** Duration in seconds */
  durationSeconds: number;
  /** Whether run was interrupted */
  interrupted: boolean;
  /** Reason for stopping if interrupted */
  stopReason?: string;
}

// === Campaign Filters ===

export interface CampaignFilters {
  /** Filter by status */
  status?: CampaignStatus | CampaignStatus[];
  /** Filter by source type */
  sourceType?: CampaignSourceType;
  /** Filter by tags (OR logic) */
  tags?: string[];
  /** Created after */
  createdAfter?: Date;
  /** Created before */
  createdBefore?: Date;
  /** Search in name/description */
  search?: string;
}

// === Campaign Issue Filters ===

export interface CampaignIssueFilters {
  /** Filter by status */
  status?: CampaignIssueStatus | CampaignIssueStatus[];
  /** Has PR */
  hasPr?: boolean;
  /** Has error */
  hasError?: boolean;
  /** Min attempts */
  minAttempts?: number;
  /** Max attempts */
  maxAttempts?: number;
}

// === Cost Breakdown ===

export interface CampaignCostBreakdown {
  /** Total cost */
  totalCost: number;
  /** Cost by issue */
  byIssue: Array<{
    issueUrl: string;
    cost: number;
    status: CampaignIssueStatus;
  }>;
  /** Average cost per issue */
  avgCostPerIssue: number;
  /** Cost for completed issues */
  completedCost: number;
  /** Cost for failed issues */
  failedCost: number;
}

// === Transition Types ===

export interface CampaignTransition {
  /** Transition ID */
  id: number;
  /** Campaign ID */
  campaignId: string;
  /** Previous status */
  fromStatus: CampaignStatus;
  /** New status */
  toStatus: CampaignStatus;
  /** When transition occurred */
  transitionedAt: string;
  /** Who triggered the transition */
  triggeredBy?: string;
  /** Reason for transition */
  reason?: string;
}

// === State Machine Helpers ===

/**
 * Valid transitions for campaign status
 */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ["active", "cancelled"],
  active: ["paused", "completed", "cancelled"],
  paused: ["active", "cancelled"],
  completed: [], // Terminal state
  cancelled: [], // Terminal state
};

/**
 * Check if a status transition is valid
 */
export function isValidCampaignTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

/**
 * Get valid next statuses for a campaign
 */
export function getValidCampaignTransitions(status: CampaignStatus): CampaignStatus[] {
  return CAMPAIGN_TRANSITIONS[status];
}

/**
 * Check if a campaign status is terminal (cannot transition)
 */
export function isCampaignTerminal(status: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[status].length === 0;
}
