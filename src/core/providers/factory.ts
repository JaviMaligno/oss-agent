/**
 * Provider Factory
 *
 * Factory functions for creating repository and issue source providers.
 */

import type { Config } from "../../types/config.js";
import type { RepositoryProviderType, IssueSourceProviderType } from "../../types/providers.js";
import type { RepositoryProvider } from "./repository/types.js";
import type { IssueSourceProvider } from "./issue-source/types.js";
import { GitHubRepositoryProvider } from "./repository/github.js";
import { GitHubEnterpriseRepositoryProvider } from "./repository/github-enterprise.js";
import { GitLabRepositoryProvider } from "./repository/gitlab.js";
import { GitHubIssueSourceProvider } from "./issue-source/github.js";
import { JiraIssueSourceProvider } from "./issue-source/jira.js";
import { LinearIssueSourceProvider } from "./issue-source/linear.js";
import { parseUrl, detectProviderType } from "./url-parser.js";
import { ConfigurationError } from "../../infra/errors.js";
import { logger } from "../../infra/logger.js";

/**
 * Options for creating providers
 */
export interface ProviderFactoryOptions {
  /** Override repository provider type */
  forceRepoProvider?: RepositoryProviderType;
  /** Override issue source provider type */
  forceIssueProvider?: IssueSourceProviderType;
}

/**
 * Registry of available repository providers
 */
const REPO_PROVIDERS = new Map<RepositoryProviderType, (config: Config) => RepositoryProvider>([
  ["github", (config) => new GitHubRepositoryProvider(config)],
  [
    "github-enterprise",
    (config) => {
      const enterpriseConfig = config.b2b?.githubEnterprise;
      if (!enterpriseConfig?.baseUrl) {
        throw new ConfigurationError("GitHub Enterprise baseUrl is required");
      }
      return new GitHubEnterpriseRepositoryProvider(config, enterpriseConfig);
    },
  ],
  ["gitlab", (config) => new GitLabRepositoryProvider(config, config.b2b?.gitlab)],
  // Bitbucket: Use MCP tools for now (already available in environment)
]);

/**
 * Registry of available issue source providers
 */
const ISSUE_SOURCE_PROVIDERS = new Map<
  IssueSourceProviderType,
  (config: Config) => IssueSourceProvider
>([
  ["github", (_config) => new GitHubIssueSourceProvider()],
  ["jira", (_config) => new JiraIssueSourceProvider()],
  ["linear", (_config) => new LinearIssueSourceProvider()],
  // Sentry: Deferred to future phase
]);

/**
 * Create a repository provider for a given URL
 */
export async function createRepositoryProviderForUrl(
  url: string,
  config: Config
): Promise<RepositoryProvider> {
  const providerType = detectProviderType(url);

  if (!providerType) {
    throw new ConfigurationError(
      `Cannot determine provider for URL: ${url}. ` +
        `Supported providers: GitHub, GitLab, Bitbucket`
    );
  }

  return createRepositoryProvider(providerType, config);
}

/**
 * Create a repository provider by type
 */
export async function createRepositoryProvider(
  type: RepositoryProviderType,
  config: Config
): Promise<RepositoryProvider> {
  const factory = REPO_PROVIDERS.get(type);

  if (!factory) {
    throw new ConfigurationError(
      `Repository provider '${type}' is not implemented. ` +
        `Available providers: ${Array.from(REPO_PROVIDERS.keys()).join(", ")}`
    );
  }

  const provider = factory(config);

  const isAvailable = await provider.isAvailable();
  if (!isAvailable) {
    throw new ConfigurationError(
      `Repository provider '${type}' is not available. ` +
        `Check your configuration and credentials.`
    );
  }

  logger.debug(`Created repository provider: ${provider.info.name}`);
  return provider;
}

/**
 * Create an issue source provider based on configuration
 */
export async function createIssueSourceProvider(
  config: Config,
  options: ProviderFactoryOptions = {}
): Promise<IssueSourceProvider> {
  const sourceType = options.forceIssueProvider ?? config.b2b?.issueSource ?? "github";

  const factory = ISSUE_SOURCE_PROVIDERS.get(sourceType);

  if (!factory) {
    throw new ConfigurationError(
      `Issue source provider '${sourceType}' is not implemented. ` +
        `Available providers: ${Array.from(ISSUE_SOURCE_PROVIDERS.keys()).join(", ")}`
    );
  }

  const provider = factory(config);

  // Initialize with config
  await provider.initialize({
    auth: { strategy: "cli" },
    settings: getIssueSourceSettings(sourceType, config),
  });

  const isAvailable = await provider.isAvailable();
  if (!isAvailable) {
    throw new ConfigurationError(
      `Issue source provider '${sourceType}' is not available. ` +
        `Check your configuration and credentials.`
    );
  }

  logger.debug(`Created issue source provider: ${provider.info.name}`);
  return provider;
}

/**
 * Get issue source settings from config
 */
function getIssueSourceSettings(
  type: IssueSourceProviderType,
  config: Config
): Record<string, unknown> {
  switch (type) {
    case "github":
      return {};
    case "jira":
      return config.b2b?.jira ?? {};
    case "linear":
      return config.b2b?.linear ?? {};
    case "sentry":
      return {};
    default:
      return {};
  }
}

/**
 * Get all configured providers (for status display)
 */
export async function getConfiguredProviders(config: Config): Promise<{
  repositories: Array<{
    type: RepositoryProviderType;
    name: string;
    available: boolean;
  }>;
  issueSources: Array<{
    type: IssueSourceProviderType;
    name: string;
    available: boolean;
  }>;
}> {
  const repositories: Array<{
    type: RepositoryProviderType;
    name: string;
    available: boolean;
  }> = [];

  const issueSources: Array<{
    type: IssueSourceProviderType;
    name: string;
    available: boolean;
  }> = [];

  // Check repository providers
  for (const [type, factory] of REPO_PROVIDERS) {
    try {
      const provider = factory(config);
      const available = await provider.isAvailable();
      repositories.push({
        type,
        name: provider.info.name,
        available,
      });
    } catch {
      repositories.push({
        type,
        name: type,
        available: false,
      });
    }
  }

  // Check issue source providers
  for (const [type, factory] of ISSUE_SOURCE_PROVIDERS) {
    try {
      const provider = factory(config);
      await provider.initialize({
        auth: { strategy: "cli" },
        settings: getIssueSourceSettings(type, config),
      });
      const available = await provider.isAvailable();
      issueSources.push({
        type,
        name: provider.info.name,
        available,
      });
    } catch {
      issueSources.push({
        type,
        name: type,
        available: false,
      });
    }
  }

  return { repositories, issueSources };
}

/**
 * Parse URL and get appropriate provider
 */
export function parseUrlWithProvider(url: string): {
  parsed: ReturnType<typeof parseUrl>;
  providerType: RepositoryProviderType | null;
} {
  const parsed = parseUrl(url);
  const providerType = detectProviderType(url);
  return { parsed, providerType };
}

/**
 * Check if a provider type is available
 */
export function isProviderTypeSupported(type: string): boolean {
  return (
    REPO_PROVIDERS.has(type as RepositoryProviderType) ||
    ISSUE_SOURCE_PROVIDERS.has(type as IssueSourceProviderType)
  );
}

/**
 * Get list of supported repository provider types
 */
export function getSupportedRepositoryProviders(): RepositoryProviderType[] {
  return Array.from(REPO_PROVIDERS.keys());
}

/**
 * Get list of supported issue source provider types
 */
export function getSupportedIssueSourceProviders(): IssueSourceProviderType[] {
  return Array.from(ISSUE_SOURCE_PROVIDERS.keys());
}
