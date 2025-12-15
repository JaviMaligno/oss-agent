/**
 * Repository Provider Types
 *
 * Defines the interface for git hosting providers (GitHub, GitLab, Bitbucket, etc.)
 */

import type {
  RepositoryProviderType,
  ProviderInfo,
  ParsedUrl,
  ConnectionTestResult,
} from "../../../types/providers.js";
import type { PullRequest, PRReview, PRComment, PRCheck } from "../../../types/pr.js";
import type { Project } from "../../../types/project.js";

/**
 * Capabilities that vary between repository providers
 */
export interface RepositoryCapabilities {
  /** Supports forking repositories */
  forking: boolean;
  /** Supports draft PRs/MRs */
  draftPRs: boolean;
  /** Supports PR reviews */
  reviews: boolean;
  /** Supports inline code comments */
  inlineComments: boolean;
  /** Supports CI status checks */
  statusChecks: boolean;
  /** Supports auto-merge */
  autoMerge: boolean;
  /** Supports branch protection rules */
  branchProtection: boolean;
  /** Supports code owners */
  codeOwners: boolean;
  /** PR/MR terminology (for display purposes) */
  prTerminology: "pull_request" | "merge_request";
}

/**
 * Repository information
 */
export interface RepoInfo {
  /** Repository owner/organization */
  owner: string;
  /** Repository name */
  name: string;
  /** Full name (owner/name) */
  fullName: string;
  /** Web URL */
  url: string;
  /** HTTPS clone URL */
  cloneUrl: string;
  /** SSH clone URL */
  sshUrl: string;
  /** Default branch name */
  defaultBranch: string;
  /** Whether repository is private */
  isPrivate: boolean;
  /** Whether this is a fork */
  isFork: boolean;
  /** Whether repository is archived */
  isArchived: boolean;
  /** Parent repository info (if this is a fork) */
  parent?: {
    owner: string;
    name: string;
    fullName: string;
  };
}

/**
 * Permission check result
 */
export interface PermissionCheck {
  /** User can push directly to the repository */
  canPush: boolean;
  /** User can create pull requests */
  canCreatePR: boolean;
  /** User can merge pull requests */
  canMerge: boolean;
  /** User is a member of the repository/organization */
  isMember: boolean;
  /** User is the owner of the repository */
  isOwner: boolean;
  /** User has admin access */
  isAdmin: boolean;
}

/**
 * Fork operation result
 */
export interface ForkResult {
  /** The forked repository */
  fork: RepoInfo;
  /** Whether the fork was newly created (vs existing) */
  created: boolean;
}

/**
 * Options for creating a pull request
 */
export interface CreatePROptions {
  /** PR title */
  title: string;
  /** PR body/description */
  body: string;
  /** Source branch name */
  head: string;
  /** Target branch name */
  base: string;
  /** Create as draft PR */
  draft?: boolean;
  /** For cross-fork PRs: "owner:branch" format or full repo reference */
  headRepo?: string;
  /** Labels to add */
  labels?: string[];
  /** Reviewers to request */
  reviewers?: string[];
  /** Issue URL to link */
  linkedIssue?: string;
}

/**
 * Result of creating a pull request
 */
export interface CreatePRResult {
  /** PR URL */
  url: string;
  /** PR number */
  number: number;
  /** PR identifier (provider-specific) */
  id: string;
}

/**
 * Options for updating a pull request
 */
export interface UpdatePROptions {
  /** New title */
  title?: string;
  /** New body */
  body?: string;
  /** New state */
  state?: "open" | "closed";
  /** Convert to/from draft */
  draft?: boolean;
}

/**
 * Combined PR feedback data
 */
export interface PRFeedbackData {
  /** Pull request data */
  pr: PullRequest;
  /** All reviews */
  reviews: PRReview[];
  /** All comments */
  comments: PRComment[];
  /** CI check status */
  checks: PRCheck[];
}

/**
 * Repository Provider Interface
 *
 * Handles all git hosting operations: repository info, permissions, forking, and PRs.
 * Implementations exist for GitHub, GitLab, Bitbucket, and GitHub Enterprise.
 */
export interface RepositoryProvider {
  /** Provider metadata */
  readonly info: ProviderInfo & { type: RepositoryProviderType };

  /** Provider capabilities */
  readonly capabilities: RepositoryCapabilities;

  // === Availability ===

  /**
   * Check if the provider is available and properly configured
   */
  isAvailable(): Promise<boolean>;

  /**
   * Test connection to the provider
   */
  testConnection(): Promise<ConnectionTestResult>;

  // === URL Handling ===

  /**
   * Check if this provider can handle the given URL
   */
  canHandleUrl(url: string): boolean;

  /**
   * Parse a URL into its components
   * @returns Parsed URL or null if not parseable
   */
  parseUrl(url: string): ParsedUrl | null;

  /**
   * Build a URL for a resource
   */
  buildUrl(parsed: Omit<ParsedUrl, "provider" | "host">): string;

  // === Repository Operations ===

  /**
   * Get repository information
   */
  getRepoInfo(owner: string, repo: string): Promise<RepoInfo>;

  /**
   * Check user permissions on a repository
   */
  checkPermissions(owner: string, repo: string): Promise<PermissionCheck>;

  /**
   * Get the current authenticated user
   */
  getCurrentUser(): Promise<string>;

  /**
   * Fork a repository (creates or returns existing fork)
   */
  forkRepo(owner: string, repo: string): Promise<ForkResult>;

  /**
   * Sync fork with upstream
   */
  syncFork(owner: string, repo: string, branch?: string): Promise<void>;

  /**
   * Get project metadata (for discovery/scoring)
   */
  getProject(owner: string, repo: string): Promise<Project | null>;

  // === Pull Request Operations ===

  /**
   * Create a pull request
   */
  createPR(owner: string, repo: string, options: CreatePROptions): Promise<CreatePRResult>;

  /**
   * Get PR details
   */
  getPR(owner: string, repo: string, prNumber: number): Promise<PullRequest>;

  /**
   * Get PR reviews
   */
  getReviews(owner: string, repo: string, prNumber: number): Promise<PRReview[]>;

  /**
   * Get PR comments (both issue comments and review comments)
   */
  getComments(owner: string, repo: string, prNumber: number): Promise<PRComment[]>;

  /**
   * Get CI check status
   */
  getChecks(owner: string, repo: string, prNumber: number): Promise<PRCheck[]>;

  /**
   * Get complete PR feedback (convenience method)
   */
  getPRFeedback(owner: string, repo: string, prNumber: number): Promise<PRFeedbackData>;

  /**
   * Update PR (title, body, state)
   */
  updatePR(owner: string, repo: string, prNumber: number, updates: UpdatePROptions): Promise<void>;

  /**
   * Add comment to PR
   */
  addComment(owner: string, repo: string, prNumber: number, body: string): Promise<void>;
}
