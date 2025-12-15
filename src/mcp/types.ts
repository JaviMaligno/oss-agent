import { z } from "zod";

// ============================================================================
// MCP Tool Input Schemas
// ============================================================================

// Workflow Tools
export const WorkOnIssueInputSchema = z.object({
  issueUrl: z.string().url().describe("GitHub issue URL to work on"),
  maxBudgetUsd: z.number().positive().optional().describe("Maximum budget for this issue"),
  skipPR: z.boolean().optional().describe("Skip PR creation (just implement and commit)"),
  dryRun: z.boolean().optional().describe("Analyze without making changes"),
});

export const IterateOnFeedbackInputSchema = z.object({
  prUrl: z.string().url().describe("GitHub PR URL to iterate on"),
  maxBudgetUsd: z.number().positive().optional().describe("Maximum budget for iteration"),
  instructions: z.string().optional().describe("Additional instructions for the AI"),
});

export const ResumeSessionInputSchema = z.object({
  sessionId: z.string().describe("Session ID to resume"),
});

export const WatchPrsInputSchema = z.object({
  intervalMinutes: z.number().int().positive().optional().describe("Polling interval in minutes"),
  maxIterations: z.number().int().positive().optional().describe("Max iterations per PR"),
  autoIterate: z.boolean().optional().describe("Automatically address feedback"),
});

// Discovery Tools
export const DiscoverProjectsInputSchema = z.object({
  mode: z
    .enum(["direct", "search", "intelligent", "curated"])
    .optional()
    .describe("Discovery mode"),
  language: z.string().optional().describe("Primary language filter"),
  minStars: z.number().int().nonnegative().optional().describe("Minimum star count"),
  maxStars: z.number().int().positive().optional().describe("Maximum star count"),
  topics: z.array(z.string()).optional().describe("Repository topics to filter by"),
  domain: z.string().optional().describe("Domain category (ai-ml, devtools, etc.)"),
  framework: z.string().optional().describe("Framework filter (react, fastapi, etc.)"),
  limit: z.number().int().positive().optional().describe("Maximum results to return"),
});

export const SuggestIssuesInputSchema = z.object({
  projectId: z.string().optional().describe("Project ID to suggest issues from"),
  repoUrl: z.string().url().optional().describe("Repository URL to suggest issues from"),
  limit: z.number().int().positive().optional().describe("Maximum issues to return"),
  filterLabels: z.array(z.string()).optional().describe("Labels to include"),
  excludeLabels: z.array(z.string()).optional().describe("Labels to exclude"),
});

// Queue Tools
export const QueueAddInputSchema = z.object({
  issueUrl: z.string().url().describe("GitHub issue URL to add"),
  priority: z.number().int().optional().describe("Priority (higher = more important)"),
});

export const QueueRemoveInputSchema = z.object({
  issueId: z.string().describe("Issue ID to remove from queue"),
});

export const QueuePrioritizeInputSchema = z.object({
  issueId: z.string().describe("Issue ID to prioritize"),
  priority: z.number().int().describe("New priority value"),
});

// Autonomous Tools
export const RunAutonomousInputSchema = z.object({
  maxIterations: z.number().int().positive().optional().describe("Maximum issues to process"),
  maxDurationHours: z.number().positive().optional().describe("Maximum run duration in hours"),
  maxBudgetUsd: z.number().positive().optional().describe("Maximum budget for the run"),
  cooldownMs: z.number().int().nonnegative().optional().describe("Delay between issues"),
  autoReplenish: z.boolean().optional().describe("Auto-replenish queue when low"),
  dryRun: z.boolean().optional().describe("Simulate without making changes"),
});

export const WorkParallelInputSchema = z.object({
  count: z.number().int().positive().describe("Number of issues to work on in parallel"),
  issueUrls: z.array(z.string().url()).optional().describe("Specific issue URLs (or use queue)"),
});

export const CancelWorkInputSchema = z.object({
  issueId: z.string().describe("Issue ID to cancel"),
});

// Monitoring Tools
export const GetPrStatusInputSchema = z.object({
  prUrl: z.string().url().optional().describe("PR URL (omit to list all monitored PRs)"),
});

export const GetSessionHistoryInputSchema = z.object({
  limit: z.number().int().positive().optional().describe("Maximum sessions to return"),
  status: z
    .enum(["active", "completed", "failed", "paused"])
    .optional()
    .describe("Filter by status"),
  issueId: z.string().optional().describe("Filter by issue ID"),
});

// Management Tools
export const GetConfigInputSchema = z.object({
  key: z.string().optional().describe("Specific config key (dot notation)"),
});

export const UpdateConfigInputSchema = z.object({
  key: z.string().describe("Config key to update (dot notation)"),
  value: z.unknown().describe("New value"),
});

export const CleanupWorktreesInputSchema = z.object({
  olderThanHours: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Only cleanup older than N hours"),
  projectId: z.string().optional().describe("Only cleanup for specific project"),
  force: z.boolean().optional().describe("Force cleanup even if in use"),
});

// Campaign Tools (B2B)
export const CampaignCreateInputSchema = z.object({
  name: z.string().describe("Campaign name"),
  description: z.string().optional().describe("Campaign description"),
  budgetUsd: z.number().positive().optional().describe("Campaign budget"),
});

export const CampaignAddIssuesInputSchema = z.object({
  campaignId: z.string().describe("Campaign ID"),
  issueUrls: z.array(z.string().url()).describe("Issue URLs to add"),
});

export const CampaignActionInputSchema = z.object({
  campaignId: z.string().describe("Campaign ID"),
});

// ============================================================================
// MCP Tool Output Types
// ============================================================================

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface WorkOnIssueResult {
  sessionId: string;
  issueUrl: string;
  prUrl?: string;
  status: "completed" | "failed" | "skipped";
  metrics: {
    turnsUsed: number;
    filesChanged: number;
    linesChanged: number;
    durationMs: number;
  };
  message?: string;
}

export interface IterateResult {
  sessionId: string;
  prUrl: string;
  iterationNumber: number;
  status: "completed" | "failed" | "needs_human";
  feedbackAddressed: number;
  metrics: {
    turnsUsed: number;
    filesChanged: number;
    linesChanged: number;
    durationMs: number;
  };
}

export interface ProjectInfo {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  description?: string;
  language?: string;
  stars: number;
  forks: number;
  openIssues: number;
  topics: string[];
  url: string;
  healthScore?: number;
}

export interface IssueInfo {
  id: string;
  number: number;
  title: string;
  url: string;
  state: string;
  labels: string[];
  author: string;
  createdAt: string;
  score?: number;
}

export interface QueueItem {
  id: string;
  issueUrl: string;
  issueNumber: number;
  title: string;
  repoFullName: string;
  priority: number;
  addedAt: string;
  status: string;
}

export interface SessionInfo {
  id: string;
  issueUrl: string;
  status: string;
  prUrl?: string;
  branch?: string;
  createdAt: string;
  updatedAt: string;
  metrics?: {
    turnsUsed: number;
    filesChanged: number;
    linesChanged: number;
  };
}

export interface StatusInfo {
  budget: {
    dailySpentUsd: number;
    dailyLimitUsd: number;
    monthlySpentUsd: number;
    monthlyLimitUsd: number;
  };
  queue: {
    size: number;
    minSize: number;
    targetSize: number;
  };
  activeSessions: number;
  monitoredPrs: number;
  health: {
    status: "healthy" | "degraded" | "unhealthy";
    lastCheck: string;
    issues?: string[];
  };
}

export interface OperationStatus {
  operationId: string;
  type: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  progress?: {
    current: number;
    total: number;
    message?: string;
  };
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

// ============================================================================
// MCP Resource URIs
// ============================================================================

export type ResourceUri =
  | "config://current"
  | "config://defaults"
  | `state://issues?${string}`
  | `state://sessions?${string}`
  | `state://audit-log?${string}`
  | "queue://current"
  | "queue://stats"
  | `operations://${string}`;

// ============================================================================
// MCP Tool Names
// ============================================================================

export type MCPToolName =
  // Workflow
  | "work_on_issue"
  | "iterate_on_feedback"
  | "resume_session"
  | "watch_prs"
  // Discovery
  | "discover_projects"
  | "suggest_issues"
  // Queue
  | "queue_list"
  | "queue_add"
  | "queue_remove"
  | "queue_prioritize"
  | "queue_clear"
  // Autonomous
  | "run_autonomous"
  | "work_parallel"
  | "cancel_work"
  | "parallel_status"
  // Monitoring
  | "get_pr_status"
  | "get_session_history"
  | "get_status"
  // Management
  | "get_config"
  | "update_config"
  | "cleanup_worktrees"
  // Campaign (B2B)
  | "campaign_create"
  | "campaign_list"
  | "campaign_show"
  | "campaign_add_issues"
  | "campaign_start"
  | "campaign_pause"
  | "campaign_resume"
  | "campaign_status";

// ============================================================================
// MCP Server Context
// ============================================================================

export interface MCPContext {
  /** Send progress notification to client */
  sendProgress: (params: {
    progressToken: string;
    progress: number;
    total?: number;
    message?: string;
  }) => Promise<void>;

  /** Check if operation was cancelled */
  isCancelled: () => boolean;

  /** Client ID for rate limiting */
  clientId?: string;
}

// ============================================================================
// Tool Handler Type
// ============================================================================

export type ToolHandler<TInput, TOutput> = (
  input: TInput,
  context: MCPContext
) => Promise<ToolResult<TOutput>>;

// ============================================================================
// Input type inference helpers
// ============================================================================

export type WorkOnIssueInput = z.infer<typeof WorkOnIssueInputSchema>;
export type IterateOnFeedbackInput = z.infer<typeof IterateOnFeedbackInputSchema>;
export type ResumeSessionInput = z.infer<typeof ResumeSessionInputSchema>;
export type WatchPrsInput = z.infer<typeof WatchPrsInputSchema>;
export type DiscoverProjectsInput = z.infer<typeof DiscoverProjectsInputSchema>;
export type SuggestIssuesInput = z.infer<typeof SuggestIssuesInputSchema>;
export type QueueAddInput = z.infer<typeof QueueAddInputSchema>;
export type QueueRemoveInput = z.infer<typeof QueueRemoveInputSchema>;
export type QueuePrioritizeInput = z.infer<typeof QueuePrioritizeInputSchema>;
export type RunAutonomousInput = z.infer<typeof RunAutonomousInputSchema>;
export type WorkParallelInput = z.infer<typeof WorkParallelInputSchema>;
export type CancelWorkInput = z.infer<typeof CancelWorkInputSchema>;
export type GetPrStatusInput = z.infer<typeof GetPrStatusInputSchema>;
export type GetSessionHistoryInput = z.infer<typeof GetSessionHistoryInputSchema>;
export type GetConfigInput = z.infer<typeof GetConfigInputSchema>;
export type UpdateConfigInput = z.infer<typeof UpdateConfigInputSchema>;
export type CleanupWorktreesInput = z.infer<typeof CleanupWorktreesInputSchema>;
export type CampaignCreateInput = z.infer<typeof CampaignCreateInputSchema>;
export type CampaignAddIssuesInput = z.infer<typeof CampaignAddIssuesInputSchema>;
export type CampaignActionInput = z.infer<typeof CampaignActionInputSchema>;
