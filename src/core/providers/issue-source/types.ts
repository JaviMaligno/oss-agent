/**
 * Issue Source Provider Types
 *
 * Defines the interface for issue/ticket providers (GitHub Issues, Jira, Linear, Sentry)
 */

import type {
  IssueSourceProviderType,
  ProviderInfo,
  ParsedIssueRef,
  ConnectionTestResult,
  ProviderConfig,
  WebhookConfig,
} from "../../../types/providers.js";
import type { Issue, IssueState, IssueComment } from "../../../types/issue.js";

/**
 * Capabilities that vary between issue source providers
 */
export interface IssueSourceCapabilities {
  /** Supports issue labels/tags */
  labels: boolean;
  /** Supports issue assignment */
  assignment: boolean;
  /** Supports issue priority */
  priority: boolean;
  /** Supports issue estimation/story points */
  estimation: boolean;
  /** Supports sprints/iterations/cycles */
  sprints: boolean;
  /** Supports custom fields */
  customFields: boolean;
  /** Supports issue linking (parent/child, blocks, etc.) */
  linking: boolean;
  /** Supports workflows/status transitions */
  workflows: boolean;
  /** Can link to external PRs */
  externalPRLinking: boolean;
  /** Supports webhooks for real-time updates */
  webhooks: boolean;
}

/**
 * Query options for fetching issues
 */
export interface IssueQueryOptions {
  /** State filter */
  state?: "open" | "closed" | "all";
  /** Label filters (AND logic) */
  labels?: string[];
  /** Exclude labels */
  excludeLabels?: string[];
  /** Assignee filter (null = unassigned, undefined = any) */
  assignee?: string | null;
  /** Author filter */
  author?: string;
  /** Sort field */
  sortBy?: "created" | "updated" | "priority" | "votes";
  /** Sort direction */
  sortDirection?: "asc" | "desc";
  /** Maximum results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Pagination cursor */
  cursor?: string;
  /** Provider-specific query (JQL for Jira, GraphQL filter for Linear, etc.) */
  customQuery?: string;
  /** Only issues updated after this date */
  updatedAfter?: Date;
}

/**
 * Result of issue query
 */
export interface IssueQueryResult {
  /** Issues matching the query */
  issues: ProviderIssue[];
  /** Total count (if available) */
  totalCount?: number;
  /** Whether more results are available */
  hasMore: boolean;
  /** Cursor for next page */
  nextCursor?: string;
}

/**
 * External issue representation (before mapping to internal Issue type)
 */
export interface ProviderIssue {
  /** External system's unique identifier */
  externalId: string;
  /** External system's URL to the issue */
  url: string;
  /** Issue key (e.g., "PROJ-123" for Jira, "TEAM-123" for Linear) */
  key: string;
  /** Issue number (for GitHub-style providers) */
  number?: number;
  /** Issue title/summary */
  title: string;
  /** Issue description/body (may be markdown or plain text) */
  body: string;
  /** Status/state in external system */
  status: string;
  /** Normalized priority */
  priority: "highest" | "high" | "medium" | "low" | "lowest" | "none";
  /** Labels/tags */
  labels: string[];
  /** Creation timestamp */
  createdAt: Date;
  /** Last update timestamp */
  updatedAt: Date;
  /** Author/reporter */
  author: string;
  /** Assignee(s) */
  assignees: string[];
  /** Comments */
  comments: IssueComment[];
  /** Source provider type */
  source: IssueSourceProviderType;
  /** Repository info (if available) */
  repository?: {
    owner: string;
    name: string;
    fullName: string;
  };
  /** Provider-specific metadata */
  metadata: Record<string, unknown>;
}

/**
 * Status transition option for workflow-aware providers
 */
export interface IssueTransitionOption {
  /** Transition ID */
  id: string;
  /** Transition name */
  name: string;
  /** Target status after transition */
  toStatus: string;
}

/**
 * Sync event from external system (webhook or polling)
 */
export interface IssueSyncEvent {
  /** Event type */
  type: "issue_created" | "issue_updated" | "issue_deleted" | "comment_added" | "status_changed";
  /** Issue key/ID */
  issueKey: string;
  /** Event timestamp */
  timestamp: Date;
  /** Actor who triggered the event */
  actor: string;
  /** Changed fields (for updates) */
  changes?: Record<string, { from: unknown; to: unknown }>;
}

/**
 * Issue Source Provider Interface
 *
 * Handles issue/ticket fetching and status updates from various sources.
 * Implementations exist for GitHub Issues, Jira, Linear, and Sentry.
 */
export interface IssueSourceProvider {
  /** Provider metadata */
  readonly info: ProviderInfo & { type: IssueSourceProviderType };

  /** Provider capabilities */
  readonly capabilities: IssueSourceCapabilities;

  // === Lifecycle ===

  /**
   * Initialize the provider with configuration
   */
  initialize(config: ProviderConfig): Promise<void>;

  /**
   * Check if the provider is available and properly configured
   */
  isAvailable(): Promise<boolean>;

  /**
   * Test connection to the external system
   */
  testConnection(): Promise<ConnectionTestResult>;

  // === URL/ID Parsing ===

  /**
   * Check if this provider handles the given URL or ID
   */
  canHandleUrl(url: string): boolean;

  /**
   * Parse an issue URL or ID into its components
   */
  parseIssueRef(ref: string): ParsedIssueRef | null;

  /**
   * Build a URL for an issue
   */
  buildIssueUrl(projectKey: string, issueKey: string | number): string;

  // === Issue Operations ===

  /**
   * Fetch a single issue by key/ID
   */
  getIssue(issueRef: string): Promise<ProviderIssue | null>;

  /**
   * Fetch issues matching criteria
   */
  queryIssues(projectKey: string, options?: IssueQueryOptions): Promise<IssueQueryResult>;

  /**
   * Get available labels/tags for a project
   */
  getLabels(projectKey: string): Promise<string[]>;

  /**
   * Get issue comments
   */
  getComments(issueRef: string): Promise<IssueComment[]>;

  // === Issue Updates ===

  /**
   * Add a comment to an issue
   */
  addComment(issueRef: string, body: string): Promise<void>;

  /**
   * Update issue status (if workflows supported)
   * @returns true if transition succeeded
   */
  transitionIssue?(issueRef: string, transitionId: string): Promise<boolean>;

  /**
   * Get available transitions (if workflows supported)
   */
  getTransitions?(issueRef: string): Promise<IssueTransitionOption[]>;

  /**
   * Assign issue to user
   */
  assignIssue?(issueRef: string, assignee: string | null): Promise<void>;

  /**
   * Add labels to issue
   */
  addLabels?(issueRef: string, labels: string[]): Promise<void>;

  /**
   * Remove labels from issue
   */
  removeLabels?(issueRef: string, labels: string[]): Promise<void>;

  /**
   * Link issue to PR (for providers that support external PR linking)
   */
  linkToPR?(issueRef: string, prUrl: string): Promise<void>;

  // === Conversion ===

  /**
   * Convert provider-specific issue to normalized Issue type
   */
  toNormalizedIssue(providerIssue: ProviderIssue, projectId: string): Issue;

  /**
   * Map internal state to external status
   */
  mapStateToExternalStatus(state: IssueState): string;

  /**
   * Map external status to internal state
   */
  mapExternalStatusToState(status: string): IssueState;

  // === Sync (Optional) ===

  /**
   * Process incoming sync event (webhook payload)
   */
  processSyncEvent?(event: IssueSyncEvent): Promise<void>;

  /**
   * Get webhook configuration (if supported)
   */
  getWebhookConfig?(): WebhookConfig;
}
