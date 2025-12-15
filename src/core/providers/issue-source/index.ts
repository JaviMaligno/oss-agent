/**
 * Issue Source Provider Module
 *
 * Re-exports for the issue source provider abstraction.
 */

// Types
export type {
  IssueSourceProvider,
  IssueSourceCapabilities,
  IssueQueryOptions,
  IssueQueryResult,
  ProviderIssue,
  IssueTransitionOption,
  IssueSyncEvent,
} from "./types.js";

// Implementations
export { GitHubIssueSourceProvider } from "./github.js";
export { JiraIssueSourceProvider } from "./jira.js";
export { LinearIssueSourceProvider } from "./linear.js";
