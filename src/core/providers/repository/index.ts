/**
 * Repository Provider Module
 *
 * Re-exports for the repository provider abstraction.
 */

// Types
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
} from "./types.js";

// Implementations
export { GitHubRepositoryProvider } from "./github.js";
export type { GitHubProviderConfig } from "./github.js";

export { GitHubEnterpriseRepositoryProvider } from "./github-enterprise.js";
export { GitLabRepositoryProvider } from "./gitlab.js";
