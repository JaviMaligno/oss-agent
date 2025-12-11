import { spawn } from "node:child_process";
import { logger } from "../../infra/logger.js";
import type { Project, AutomatedTool, ProjectScore } from "../../types/project.js";
import type { OSSConfig } from "../../types/config.js";
import type { AIProvider } from "../../core/ai/index.js";
import {
  getDomainConfig,
  getFrameworkConfig,
  getValidDomains,
  getValidFrameworks,
  AUTOMATED_FEEDBACK_DETECTION,
} from "./domain-mappings.js";
import {
  parseCuratedList,
  getCuratedListsForTopic,
  getCuratedListCategories,
} from "./curated-list-parser.js";
import { intelligentDiscovery, type IntelligentSearchConfig } from "./search-agent.js";

// Re-export curated list helpers
export { getCuratedListCategories } from "./curated-list-parser.js";

export interface DiscoveryConfig {
  mode: "direct" | "search" | "intelligent" | "curated";
  // Direct mode - explicit repos
  directRepos?: string[] | undefined;
  // Search mode criteria
  language?: string | undefined;
  minStars?: number | undefined;
  maxStars?: number | undefined;
  topics?: string[] | undefined;
  // Domain and framework filters
  domain?: string | undefined;
  framework?: string | undefined;
  // Curated list mode - specify list repo or topic
  curatedList?: string | undefined; // e.g., "vinta/awesome-python" or "python"
  // Intelligent mode - natural language query
  intelligentQuery?: string | undefined; // e.g., "Python security tools for API testing"
  // Shared filters
  requireContributingGuide?: boolean | undefined;
  excludeArchived?: boolean | undefined;
  excludeForks?: boolean | undefined;
}

// Re-export for CLI usage
export { getValidDomains, getValidFrameworks } from "./domain-mappings.js";

export interface SearchCriteria {
  language?: string | undefined;
  minStars?: number | undefined;
  maxStars?: number | undefined;
  topics?: string[] | undefined;
  hasGoodFirstIssues?: boolean | undefined;
  hasHelpWantedIssues?: boolean | undefined;
  pushedAfter?: string | undefined; // ISO date string
}

interface GitHubSearchResult {
  owner: { login: string };
  name: string;
  url: string;
  description: string | null;
  stargazerCount: number;
  forkCount: number;
  primaryLanguage: { name: string } | null;
  licenseInfo: { spdxId: string } | null;
  defaultBranchRef: { name: string } | null;
  repositoryTopics: { nodes: Array<{ topic: { name: string } }> };
  isArchived: boolean;
  isFork: boolean;
  pushedAt: string;
  issues: { totalCount: number };
}

// gh repo view returns a different structure
interface GitHubRepoViewResult {
  owner: { login: string };
  name: string;
  url: string;
  description: string | null;
  stargazerCount: number;
  forkCount: number;
  primaryLanguage: { name: string } | null;
  licenseInfo: { key: string; name: string } | null;
  defaultBranchRef: { name: string } | null;
  repositoryTopics: Array<{ name: string }>; // Different format!
  isArchived: boolean;
  isFork: boolean;
  pushedAt: string;
  issues: { totalCount: number };
}

/**
 * DiscoveryService - Find OSS projects to contribute to
 */
export class DiscoveryService {
  private aiProvider?: AIProvider | undefined;

  constructor(private ossConfig?: OSSConfig) {}

  /**
   * Set the AI provider for intelligent mode
   */
  setAIProvider(provider: AIProvider): void {
    this.aiProvider = provider;
  }

  /**
   * Discover projects based on configuration
   */
  async discover(config: DiscoveryConfig): Promise<Project[]> {
    logger.debug(`Discovery mode: ${config.mode}`);

    // Build search criteria from domain/framework if specified
    const searchCriteria = this.buildSearchCriteriaFromConfig(config);

    switch (config.mode) {
      case "direct":
        return this.discoverDirect(config.directRepos ?? []);
      case "search":
        return this.discoverBySearch(searchCriteria);
      case "intelligent": {
        // Use AI agent if query provided and AI is available
        if (config.intelligentQuery && this.aiProvider) {
          return this.discoverWithAI(config.intelligentQuery, config);
        }
        // Fallback to search with scoring
        logger.debug("AI not available or no query, falling back to scored search");
        const candidates = await this.discoverBySearch({
          ...searchCriteria,
          hasGoodFirstIssues: true,
        });
        return this.sortByScore(candidates);
      }
      case "curated":
        return this.discoverFromCuratedList(config.curatedList ?? "", config);
      default:
        throw new Error(`Unknown discovery mode: ${config.mode}`);
    }
  }

  /**
   * Discover projects using AI-powered intelligent search
   */
  async discoverWithAI(query: string, config: DiscoveryConfig): Promise<Project[]> {
    if (!this.aiProvider) {
      throw new Error("AI provider not configured for intelligent discovery");
    }

    logger.info(`Starting AI-powered discovery for: "${query}"`);

    const searchConfig: IntelligentSearchConfig = {
      query,
      maxProjects: 20,
      strategies: {
        useWebSearch: true,
        useGitHubSearch: true,
        useCuratedLists: true,
      },
    };

    const projects = await intelligentDiscovery(searchConfig, this.aiProvider);

    // Apply additional filters from config
    let filtered = projects;

    if (config.minStars !== undefined) {
      filtered = filtered.filter((p) => p.stars >= (config.minStars ?? 0));
    }
    if (config.maxStars !== undefined) {
      filtered = filtered.filter((p) => p.stars <= (config.maxStars ?? Infinity));
    }
    if (config.language) {
      filtered = filtered.filter(
        (p) => p.language?.toLowerCase() === config.language?.toLowerCase()
      );
    }

    // Enrich projects with additional data
    const enriched = await Promise.all(
      filtered.map(async (p) => {
        try {
          const detailed = await this.getProjectInfo(p.fullName);
          return detailed ?? p;
        } catch {
          return p;
        }
      })
    );

    return enriched;
  }

  /**
   * Discover projects from curated awesome-* lists
   */
  async discoverFromCuratedList(listRef: string, config: DiscoveryConfig): Promise<Project[]> {
    // Determine which lists to parse
    let listRepos: string[] = [];

    if (listRef.includes("/")) {
      // Direct repo reference like "vinta/awesome-python"
      listRepos = [listRef];
    } else {
      // Topic reference like "python" - look up curated lists for that topic
      listRepos = getCuratedListsForTopic(listRef);
      if (listRepos.length === 0) {
        logger.warn(`No curated lists found for topic: ${listRef}`);
        logger.info(`Available categories: ${getCuratedListCategories().join(", ")}`);
        return [];
      }
    }

    logger.debug(`Parsing curated lists: ${listRepos.join(", ")}`);

    const allProjects: Project[] = [];
    const seenRepos = new Set<string>();

    for (const listRepo of listRepos) {
      logger.debug(`Parsing list: ${listRepo}`);
      const parsed = await parseCuratedList(listRepo);
      logger.debug(`Found ${parsed.length} projects in ${listRepo}`);

      // Get detailed info for each parsed project
      for (const p of parsed) {
        if (seenRepos.has(p.fullName)) {
          continue;
        }
        seenRepos.add(p.fullName);

        try {
          const project = await this.getProjectInfo(p.fullName);
          if (project) {
            // Apply filters
            if (config.minStars !== undefined && project.stars < config.minStars) {
              continue;
            }
            if (config.maxStars !== undefined && project.stars > config.maxStars) {
              continue;
            }
            if (
              config.language &&
              project.language?.toLowerCase() !== config.language.toLowerCase()
            ) {
              continue;
            }
            allProjects.push(project);
          }
        } catch (error) {
          logger.debug(`Failed to get info for ${p.fullName}: ${error}`);
        }

        // Stop if we have enough
        if (allProjects.length >= 50) {
          break;
        }
      }

      if (allProjects.length >= 50) {
        break;
      }
    }

    return allProjects;
  }

  /**
   * Build search criteria from config, expanding domain and framework
   */
  private buildSearchCriteriaFromConfig(config: DiscoveryConfig): SearchCriteria {
    const criteria: SearchCriteria = {
      language: config.language,
      minStars: config.minStars ?? this.ossConfig?.minStars ?? 100,
      maxStars: config.maxStars ?? this.ossConfig?.maxStars ?? 50000,
      topics: config.topics ? [...config.topics] : [],
    };

    // Expand domain to topics
    if (config.domain) {
      const domainConfig = getDomainConfig(config.domain);
      if (domainConfig) {
        logger.debug(
          `Expanding domain '${config.domain}' to topics: ${domainConfig.topics.join(", ")}`
        );
        criteria.topics = criteria.topics ?? [];
        // Add domain topics (use first 2 to avoid overly specific searches)
        criteria.topics.push(...domainConfig.topics.slice(0, 2));
      } else {
        logger.warn(
          `Unknown domain: ${config.domain}. Valid domains: ${getValidDomains().join(", ")}`
        );
      }
    }

    // Expand framework to topics and language
    if (config.framework) {
      const frameworkConfig = getFrameworkConfig(config.framework);
      if (frameworkConfig) {
        logger.debug(
          `Expanding framework '${config.framework}' to topics: ${frameworkConfig.topics.join(", ")}`
        );
        criteria.topics = criteria.topics ?? [];
        criteria.topics.push(...frameworkConfig.topics.slice(0, 2));
        // Set language if not already specified
        if (!criteria.language && frameworkConfig.languages.length > 0) {
          criteria.language = frameworkConfig.languages[0];
          logger.debug(`Setting language to ${criteria.language} based on framework`);
        }
      } else {
        logger.warn(
          `Unknown framework: ${config.framework}. Valid frameworks: ${getValidFrameworks().join(", ")}`
        );
      }
    }

    return criteria;
  }

  /**
   * Discover by explicit repository list
   */
  async discoverDirect(repos: string[]): Promise<Project[]> {
    const projects: Project[] = [];

    for (const repoRef of repos) {
      try {
        const project = await this.getProjectInfo(repoRef);
        if (project) {
          projects.push(project);
        }
      } catch (error) {
        logger.warn(`Failed to get info for ${repoRef}: ${error}`);
      }
    }

    return projects;
  }

  /**
   * Discover by GitHub search
   */
  async discoverBySearch(criteria: SearchCriteria, limit = 30): Promise<Project[]> {
    const query = this.buildSearchQuery(criteria);
    logger.debug(`Search query: ${query}`);

    try {
      const results = await this.searchRepositories(query, limit);
      return results.map((r) => this.mapSearchResultToProject(r));
    } catch (error) {
      logger.error(`Search failed: ${error}`);
      return [];
    }
  }

  /**
   * Get detailed project info for a single repo
   */
  async getProjectInfo(repoRef: string): Promise<Project | null> {
    // Parse owner/repo format
    const match = repoRef.match(/^(?:https?:\/\/github\.com\/)?([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) {
      logger.warn(`Invalid repo reference: ${repoRef}`);
      return null;
    }

    const [, owner, name] = match;

    try {
      const result = await this.gh([
        "repo",
        "view",
        `${owner}/${name}`,
        "--json",
        "owner,name,url,description,stargazerCount,forkCount,primaryLanguage,licenseInfo,defaultBranchRef,repositoryTopics,isArchived,isFork,pushedAt,issues",
      ]);

      const data = JSON.parse(result) as GitHubRepoViewResult;
      return this.mapRepoViewToProject(data);
    } catch (error) {
      logger.debug(`Failed to get repo info for ${owner}/${name}: ${error}`);
      return null;
    }
  }

  /**
   * Score a project for contribution suitability
   */
  async scoreProject(project: Project): Promise<ProjectScore> {
    const breakdown = {
      responseTime: 0,
      mergeRate: 0,
      communityHealth: 0,
      documentationQuality: 0,
      automatedFeedback: 0,
    };

    // Score based on stars (community interest)
    if (project.stars >= 1000) {
      breakdown.communityHealth += 20;
    } else if (project.stars >= 100) {
      breakdown.communityHealth += 15;
    } else {
      breakdown.communityHealth += 10;
    }

    // Score based on recent activity
    const daysSinceActivity = Math.floor(
      (Date.now() - project.lastActivityAt.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (daysSinceActivity < 7) {
      breakdown.responseTime += 25;
    } else if (daysSinceActivity < 30) {
      breakdown.responseTime += 20;
    } else if (daysSinceActivity < 90) {
      breakdown.responseTime += 10;
    }

    // Score based on open issues (opportunity)
    if (project.openIssues > 10 && project.openIssues < 500) {
      breakdown.communityHealth += 15;
    } else if (project.openIssues <= 10) {
      breakdown.communityHealth += 5;
    }

    // Score based on contributing guide
    if (project.hasContributingGuide) {
      breakdown.documentationQuality += 20;
    }

    // Score based on license
    if (project.license) {
      const permissiveLicenses = ["MIT", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "ISC"];
      if (permissiveLicenses.includes(project.license)) {
        breakdown.documentationQuality += 10;
      }
    }

    // Score based on automated tools (better feedback)
    breakdown.automatedFeedback = Math.min(project.automatedTools.length * 5, 20);

    const total =
      breakdown.responseTime +
      breakdown.mergeRate +
      breakdown.communityHealth +
      breakdown.documentationQuality +
      breakdown.automatedFeedback;

    return { total, breakdown };
  }

  /**
   * Detect automated tools from repository
   * Uses multiple strategies: config files, .github directory, and PR comments
   */
  async detectAutomatedTools(
    owner: string,
    repo: string,
    checkPRComments = false
  ): Promise<AutomatedTool[]> {
    const toolsSet = new Set<AutomatedTool>();

    // Strategy 1: Check config files in root
    try {
      const files = await this.gh(["api", `repos/${owner}/${repo}/contents`, "--jq", ".[].name"]);

      const fileList = files.split("\n").filter(Boolean);

      // Check each tool's config files
      for (const [toolName, detection] of Object.entries(AUTOMATED_FEEDBACK_DETECTION)) {
        for (const configFile of detection.configFiles) {
          // Handle nested paths like .github/dependabot.yml
          if (!configFile.includes("/") && fileList.includes(configFile)) {
            toolsSet.add(toolName as AutomatedTool);
            break;
          }
        }
      }
    } catch (error) {
      logger.debug(`Failed to check root files for ${owner}/${repo}: ${error}`);
    }

    // Strategy 2: Check .github directory
    try {
      const githubFiles = await this.gh([
        "api",
        `repos/${owner}/${repo}/contents/.github`,
        "--jq",
        ".[].name",
      ]);
      const githubFileList = githubFiles.split("\n").filter(Boolean);

      // Check for tools with configs in .github
      if (githubFileList.includes("dependabot.yml") || githubFileList.includes("dependabot.yaml")) {
        toolsSet.add("dependabot");
      }
    } catch {
      // .github directory might not exist
    }

    // Strategy 3: Check PR comments for bot activity (more comprehensive but slower)
    if (checkPRComments) {
      try {
        const detectedFromPRs = await this.detectToolsFromPRComments(owner, repo);
        for (const tool of detectedFromPRs) {
          toolsSet.add(tool);
        }
      } catch (error) {
        logger.debug(`Failed to check PR comments for ${owner}/${repo}: ${error}`);
      }
    }

    return Array.from(toolsSet);
  }

  /**
   * Detect tools by checking recent PR comments for bot authors
   */
  private async detectToolsFromPRComments(owner: string, repo: string): Promise<AutomatedTool[]> {
    const tools: AutomatedTool[] = [];

    try {
      // Get recent merged PRs to check for bot comments
      const prsResult = await this.gh([
        "pr",
        "list",
        "-R",
        `${owner}/${repo}`,
        "--state",
        "merged",
        "--limit",
        "5",
        "--json",
        "number",
      ]);

      const prs = JSON.parse(prsResult) as Array<{ number: number }>;

      if (prs.length === 0) {
        return tools;
      }

      // Check comments on the first PR (most recent)
      const firstPr = prs[0];
      if (!firstPr) {
        return tools;
      }
      const prNumber = firstPr.number;
      const commentsResult = await this.gh([
        "api",
        `repos/${owner}/${repo}/issues/${prNumber}/comments`,
        "--jq",
        ".[].user.login",
      ]);

      const commentAuthors = commentsResult.split("\n").filter(Boolean);
      const foundAuthors = new Set(commentAuthors);

      // Match comment authors to tools
      for (const [toolName, detection] of Object.entries(AUTOMATED_FEEDBACK_DETECTION)) {
        for (const botAuthor of detection.prCommentAuthors) {
          if (foundAuthors.has(botAuthor)) {
            tools.push(toolName as AutomatedTool);
            break;
          }
        }
      }
    } catch (error) {
      logger.debug(`Failed to check PR comments: ${error}`);
    }

    return tools;
  }

  /**
   * Check if repo has a CONTRIBUTING.md or similar
   */
  async hasContributingGuide(owner: string, repo: string): Promise<boolean> {
    try {
      const files = await this.gh(["api", `repos/${owner}/${repo}/contents`, "--jq", ".[].name"]);

      const fileList = files.toLowerCase().split("\n").filter(Boolean);
      return (
        fileList.includes("contributing.md") ||
        fileList.includes("contribute.md") ||
        fileList.includes(".github/contributing.md")
      );
    } catch {
      return false;
    }
  }

  /**
   * Sort projects by score (highest first)
   */
  private async sortByScore(projects: Project[]): Promise<Project[]> {
    const scored = await Promise.all(
      projects.map(async (p) => ({
        project: p,
        score: await this.scoreProject(p),
      }))
    );

    return scored.sort((a, b) => b.score.total - a.score.total).map((s) => s.project);
  }

  /**
   * Build GitHub search query from criteria
   */
  private buildSearchQuery(criteria: SearchCriteria): string {
    const parts: string[] = [];

    if (criteria.language) {
      parts.push(`language:${criteria.language}`);
    }

    if (criteria.minStars !== undefined || criteria.maxStars !== undefined) {
      const min = criteria.minStars ?? 0;
      const max = criteria.maxStars ?? "*";
      parts.push(`stars:${min}..${max}`);
    }

    if (criteria.topics && criteria.topics.length > 0) {
      for (const topic of criteria.topics) {
        parts.push(`topic:${topic}`);
      }
    }

    if (criteria.hasGoodFirstIssues) {
      parts.push("good-first-issues:>0");
    }

    if (criteria.hasHelpWantedIssues) {
      parts.push("help-wanted-issues:>0");
    }

    if (criteria.pushedAfter) {
      parts.push(`pushed:>${criteria.pushedAfter}`);
    }

    // Always exclude archived repos
    parts.push("archived:false");

    // Sort by recently updated
    parts.push("sort:updated-desc");

    return parts.join(" ");
  }

  /**
   * Search repositories using GitHub API
   */
  private async searchRepositories(query: string, limit: number): Promise<GitHubSearchResult[]> {
    // Build URL-encoded query for GET request
    const encodedQuery = encodeURIComponent(query);
    const result = await this.gh([
      "api",
      "-X",
      "GET",
      `search/repositories?q=${encodedQuery}&per_page=${Math.min(limit, 100)}`,
      "--jq",
      ".items",
    ]);

    const items = JSON.parse(result) as Array<{
      owner: { login: string };
      name: string;
      html_url: string;
      description: string | null;
      stargazers_count: number;
      forks_count: number;
      language: string | null;
      license: { spdx_id: string } | null;
      default_branch: string;
      topics: string[];
      archived: boolean;
      fork: boolean;
      pushed_at: string;
      open_issues_count: number;
    }>;

    // Map REST API response to our expected shape
    return items.map((item) => ({
      owner: { login: item.owner.login },
      name: item.name,
      url: item.html_url,
      description: item.description,
      stargazerCount: item.stargazers_count,
      forkCount: item.forks_count,
      primaryLanguage: item.language ? { name: item.language } : null,
      licenseInfo: item.license ? { spdxId: item.license.spdx_id } : null,
      defaultBranchRef: { name: item.default_branch },
      repositoryTopics: {
        nodes: item.topics.map((t) => ({ topic: { name: t } })),
      },
      isArchived: item.archived,
      isFork: item.fork,
      pushedAt: item.pushed_at,
      issues: { totalCount: item.open_issues_count },
    }));
  }

  /**
   * Map GitHub API search result to Project type
   */
  private mapSearchResultToProject(data: GitHubSearchResult): Project {
    return {
      id: `${data.owner.login}/${data.name}`,
      url: data.url,
      owner: data.owner.login,
      name: data.name,
      fullName: `${data.owner.login}/${data.name}`,
      description: data.description ?? "",
      language: data.primaryLanguage?.name ?? null,
      stars: data.stargazerCount,
      forks: data.forkCount,
      openIssues: data.issues.totalCount,
      topics: data.repositoryTopics.nodes.map((n) => n.topic.name),
      license: data.licenseInfo?.spdxId ?? null,
      defaultBranch: data.defaultBranchRef?.name ?? "main",
      lastActivityAt: new Date(data.pushedAt),
      hasContributingGuide: false, // Will be fetched separately if needed
      automatedTools: [], // Will be detected separately if needed
    };
  }

  /**
   * Map gh repo view result to Project type (different format from search API)
   */
  private mapRepoViewToProject(data: GitHubRepoViewResult): Project {
    return {
      id: `${data.owner.login}/${data.name}`,
      url: data.url,
      owner: data.owner.login,
      name: data.name,
      fullName: `${data.owner.login}/${data.name}`,
      description: data.description ?? "",
      language: data.primaryLanguage?.name ?? null,
      stars: data.stargazerCount,
      forks: data.forkCount,
      openIssues: data.issues?.totalCount ?? 0,
      topics: data.repositoryTopics?.map((t) => t.name) ?? [],
      license: data.licenseInfo?.key?.toUpperCase() ?? null,
      defaultBranch: data.defaultBranchRef?.name ?? "main",
      lastActivityAt: new Date(data.pushedAt),
      hasContributingGuide: false, // Will be fetched separately if needed
      automatedTools: [], // Will be detected separately if needed
    };
  }

  /**
   * Execute gh CLI command
   */
  private async gh(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("gh", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`gh ${args.join(" ")} failed: ${stderr}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn gh: ${err.message}`));
      });
    });
  }
}
