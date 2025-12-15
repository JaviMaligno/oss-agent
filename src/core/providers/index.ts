/**
 * Providers Module
 *
 * Unified interface for repository and issue source providers.
 * This module provides abstractions for working with different
 * git hosts (GitHub, GitLab, Bitbucket) and issue trackers
 * (GitHub Issues, Jira, Linear, Sentry).
 */

// === Factory Functions ===
export {
  createRepositoryProvider,
  createRepositoryProviderForUrl,
  createIssueSourceProvider,
  getConfiguredProviders,
  parseUrlWithProvider,
  isProviderTypeSupported,
  getSupportedRepositoryProviders,
  getSupportedIssueSourceProviders,
} from "./factory.js";
export type { ProviderFactoryOptions } from "./factory.js";

// === URL Parsing Utilities ===
export {
  parseUrl,
  detectProviderType,
  isKnownProviderUrl,
  buildRepoUrl,
  buildPRUrl,
  buildIssueUrl,
  parseShortRef,
} from "./url-parser.js";

// === Repository Provider ===
export type {
  RepositoryProvider,
  RepositoryCapabilities,
  RepoInfo,
  PermissionCheck,
  ForkResult,
  CreatePROptions,
  CreatePRResult,
  UpdatePROptions,
  PRFeedbackData,
} from "./repository/index.js";

export {
  GitHubRepositoryProvider,
  GitHubEnterpriseRepositoryProvider,
  GitLabRepositoryProvider,
} from "./repository/index.js";
export type { GitHubProviderConfig } from "./repository/index.js";

// === Issue Source Provider ===
export type {
  IssueSourceProvider,
  IssueSourceCapabilities,
  IssueQueryOptions,
  IssueQueryResult,
  ProviderIssue,
  IssueTransitionOption,
  IssueSyncEvent,
} from "./issue-source/index.js";

export {
  GitHubIssueSourceProvider,
  JiraIssueSourceProvider,
  LinearIssueSourceProvider,
} from "./issue-source/index.js";
