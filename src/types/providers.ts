/**
 * Shared types for provider abstractions
 *
 * This module defines common types used by both RepositoryProvider
 * and IssueSourceProvider interfaces for B2B mode support.
 */

/**
 * Repository provider types (git hosts)
 */
export type RepositoryProviderType = "github" | "github-enterprise" | "gitlab" | "bitbucket";

/**
 * Issue source provider types (issue trackers)
 */
export type IssueSourceProviderType = "github" | "jira" | "linear" | "sentry";

/**
 * Combined provider type
 */
export type ProviderType = RepositoryProviderType | IssueSourceProviderType;

/**
 * Authentication strategies supported by providers
 */
export type AuthStrategy = "cli" | "token" | "basic" | "oauth" | "app";

/**
 * Authentication configuration
 */
export interface AuthConfig {
  /** Authentication method */
  strategy: AuthStrategy;
  /** API token (for token auth) */
  token?: string;
  /** Username (for basic auth) */
  username?: string;
  /** Password or app password (for basic auth) */
  password?: string;
  /** OAuth client ID */
  clientId?: string;
  /** OAuth client secret */
  clientSecret?: string;
  /** GitHub App ID */
  appId?: string;
  /** GitHub App private key */
  privateKey?: string;
}

/**
 * Common provider metadata
 */
export interface ProviderInfo {
  /** Provider display name */
  readonly name: string;
  /** Provider type identifier */
  readonly type: ProviderType;
  /** Provider version */
  readonly version: string;
  /** Base URL for the provider */
  readonly baseUrl: string;
}

/**
 * Parsed URL components
 */
export interface ParsedUrl {
  /** Provider type that handles this URL */
  provider: RepositoryProviderType;
  /** Host (e.g., "github.com", "gitlab.mycompany.com") */
  host: string;
  /** Repository owner/organization */
  owner: string;
  /** Repository name */
  repo: string;
  /** Resource type if URL points to specific resource */
  resourceType?: "issue" | "pr" | "mr" | "commit" | "branch";
  /** Resource ID (issue number, PR number, etc.) */
  resourceId?: string | number;
}

/**
 * Parsed issue reference (for issue source providers)
 */
export interface ParsedIssueRef {
  /** Project key (e.g., "PROJ" for Jira, team key for Linear) */
  projectKey?: string;
  /** Issue key (e.g., "PROJ-123" for Jira) */
  issueKey?: string;
  /** Issue number (for GitHub) */
  issueNumber?: number;
  /** Full URL if available */
  url?: string;
}

/**
 * Generic provider configuration
 */
export interface ProviderConfig {
  /** Authentication configuration */
  auth: AuthConfig;
  /** Provider-specific settings */
  settings: Record<string, unknown>;
}

/**
 * Result of connection test
 */
export interface ConnectionTestResult {
  /** Whether the connection succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Additional info (e.g., authenticated user) */
  info?: Record<string, unknown>;
}

/**
 * Webhook configuration for providers that support it
 */
export interface WebhookConfig {
  /** Endpoint path */
  path: string;
  /** Events to subscribe to */
  events: string[];
  /** Secret for signature verification */
  secret?: string;
}
