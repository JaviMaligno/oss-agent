/**
 * URL Parser Utilities
 *
 * Utilities for parsing repository and issue URLs from various providers.
 */

import type { ParsedUrl, RepositoryProviderType } from "../../types/providers.js";

/**
 * URL patterns for different providers
 */
const URL_PATTERNS: Array<{
  provider: RepositoryProviderType;
  hostPattern: RegExp;
  pathPatterns: {
    repo: RegExp;
    pr: RegExp;
    issue: RegExp;
  };
}> = [
  {
    provider: "github",
    hostPattern: /^(www\.)?github\.com$/,
    pathPatterns: {
      repo: /^\/([^/]+)\/([^/]+?)(?:\.git)?$/,
      pr: /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
      issue: /^\/([^/]+)\/([^/]+)\/issues\/(\d+)/,
    },
  },
  {
    provider: "gitlab",
    hostPattern: /^(www\.)?gitlab\.com$/,
    pathPatterns: {
      repo: /^\/([^/]+(?:\/[^/]+)*)(?:\.git)?$/,
      pr: /^\/([^/]+(?:\/[^/]+)*)\/-\/merge_requests\/(\d+)/,
      issue: /^\/([^/]+(?:\/[^/]+)*)\/-\/issues\/(\d+)/,
    },
  },
  {
    provider: "bitbucket",
    hostPattern: /^(www\.)?bitbucket\.org$/,
    pathPatterns: {
      repo: /^\/([^/]+)\/([^/]+?)(?:\.git)?$/,
      pr: /^\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/,
      issue: /^\/([^/]+)\/([^/]+)\/issues\/(\d+)/,
    },
  },
];

/**
 * Parse a URL into its components
 */
export function parseUrl(url: string): ParsedUrl | null {
  try {
    const parsed = new globalThis.URL(url);
    const host = parsed.host.toLowerCase();
    const path = parsed.pathname;

    for (const config of URL_PATTERNS) {
      if (!config.hostPattern.test(host)) {
        continue;
      }

      // Try PR pattern first
      const prMatch = path.match(config.pathPatterns.pr);
      if (prMatch) {
        const result = extractOwnerRepo(prMatch, config.provider);
        if (result) {
          return {
            ...result,
            resourceType: config.provider === "gitlab" ? "mr" : "pr",
            resourceId: parseInt(prMatch[prMatch.length - 1]!, 10),
          };
        }
      }

      // Try issue pattern
      const issueMatch = path.match(config.pathPatterns.issue);
      if (issueMatch) {
        const result = extractOwnerRepo(issueMatch, config.provider);
        if (result) {
          return {
            ...result,
            resourceType: "issue",
            resourceId: parseInt(issueMatch[issueMatch.length - 1]!, 10),
          };
        }
      }

      // Try repo pattern
      const repoMatch = path.match(config.pathPatterns.repo);
      if (repoMatch) {
        const result = extractOwnerRepo(repoMatch, config.provider);
        if (result) {
          return result;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract owner and repo from regex match
 */
function extractOwnerRepo(
  match: RegExpMatchArray,
  provider: RepositoryProviderType
): ParsedUrl | null {
  if (provider === "gitlab") {
    // GitLab can have nested groups: group/subgroup/project
    const fullPath = match[1];
    if (!fullPath) return null;

    const parts = fullPath.split("/");
    if (parts.length < 2) return null;

    const repo = parts.pop()!;
    const owner = parts.join("/");

    return {
      provider,
      host: "gitlab.com",
      owner,
      repo,
    };
  }

  // GitHub and Bitbucket: simple owner/repo
  if (!match[1] || !match[2]) return null;

  return {
    provider,
    host: provider === "github" ? "github.com" : "bitbucket.org",
    owner: match[1],
    repo: match[2],
  };
}

/**
 * Detect provider type from URL
 */
export function detectProviderType(url: string): RepositoryProviderType | null {
  try {
    const parsed = new globalThis.URL(url);
    const host = parsed.host.toLowerCase();

    for (const config of URL_PATTERNS) {
      if (config.hostPattern.test(host)) {
        return config.provider;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if URL is from a known provider
 */
export function isKnownProviderUrl(url: string): boolean {
  return detectProviderType(url) !== null;
}

/**
 * Build a repository URL
 */
export function buildRepoUrl(
  provider: RepositoryProviderType,
  owner: string,
  repo: string
): string {
  switch (provider) {
    case "github":
    case "github-enterprise":
      return `https://github.com/${owner}/${repo}`;
    case "gitlab":
      return `https://gitlab.com/${owner}/${repo}`;
    case "bitbucket":
      return `https://bitbucket.org/${owner}/${repo}`;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Build a PR/MR URL
 */
export function buildPRUrl(
  provider: RepositoryProviderType,
  owner: string,
  repo: string,
  prNumber: number
): string {
  switch (provider) {
    case "github":
    case "github-enterprise":
      return `https://github.com/${owner}/${repo}/pull/${prNumber}`;
    case "gitlab":
      return `https://gitlab.com/${owner}/${repo}/-/merge_requests/${prNumber}`;
    case "bitbucket":
      return `https://bitbucket.org/${owner}/${repo}/pull-requests/${prNumber}`;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Build an issue URL
 */
export function buildIssueUrl(
  provider: RepositoryProviderType,
  owner: string,
  repo: string,
  issueNumber: number
): string {
  switch (provider) {
    case "github":
    case "github-enterprise":
      return `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
    case "gitlab":
      return `https://gitlab.com/${owner}/${repo}/-/issues/${issueNumber}`;
    case "bitbucket":
      return `https://bitbucket.org/${owner}/${repo}/issues/${issueNumber}`;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Parse a short reference like "owner/repo#123"
 */
export function parseShortRef(ref: string): {
  owner: string;
  repo: string;
  number?: number;
  type?: "issue" | "pr";
} | null {
  // owner/repo#123
  const issueMatch = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (issueMatch?.[1] && issueMatch[2] && issueMatch[3]) {
    return {
      owner: issueMatch[1],
      repo: issueMatch[2],
      number: parseInt(issueMatch[3], 10),
      type: "issue", // Could be either, but issues are more common
    };
  }

  // owner/repo
  const repoMatch = ref.match(/^([^/]+)\/([^#]+)$/);
  if (repoMatch?.[1] && repoMatch[2]) {
    return {
      owner: repoMatch[1],
      repo: repoMatch[2],
    };
  }

  return null;
}
