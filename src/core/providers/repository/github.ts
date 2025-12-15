/**
 * GitHub Repository Provider
 *
 * Implements RepositoryProvider interface by wrapping existing
 * RepoService and PRService classes. This provides a unified
 * interface for GitHub operations that can be extended for
 * GitHub Enterprise support.
 */

import { spawn } from "node:child_process";
import type {
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
import type { ProviderInfo, ParsedUrl, ConnectionTestResult } from "../../../types/providers.js";
import type { PullRequest, PRReview, PRComment, PRCheck } from "../../../types/pr.js";
import type { Project } from "../../../types/project.js";
import type { Config } from "../../../types/config.js";
import { RepoService } from "../../github/repo-service.js";
import { PRService } from "../../github/pr-service.js";
import { logger } from "../../../infra/logger.js";

/**
 * GitHub Repository Provider Configuration
 */
export interface GitHubProviderConfig {
  /** GitHub CLI path */
  ghPath?: string;
  /** Base URL (for GitHub Enterprise override) */
  baseUrl?: string;
  /** API URL (for GitHub Enterprise override) */
  apiUrl?: string;
  /** Authentication token (optional, uses gh CLI auth by default) */
  token?: string;
}

export class GitHubRepositoryProvider implements RepositoryProvider {
  readonly info: ProviderInfo & { type: "github" } = {
    name: "GitHub",
    type: "github",
    version: "1.0.0",
    baseUrl: "https://github.com",
  };

  readonly capabilities: RepositoryCapabilities = {
    forking: true,
    draftPRs: true,
    reviews: true,
    inlineComments: true,
    statusChecks: true,
    autoMerge: true,
    branchProtection: true,
    codeOwners: true,
    prTerminology: "pull_request",
  };

  protected repoService: RepoService;
  protected prService: PRService;
  protected ghPath: string;

  constructor(
    protected config: Config,
    protected providerConfig: GitHubProviderConfig = {}
  ) {
    this.repoService = new RepoService();
    const ghPath = providerConfig.ghPath ?? "gh";
    this.prService = new PRService({ ghPath });
    this.ghPath = ghPath;
  }

  // === Availability ===

  async isAvailable(): Promise<boolean> {
    return this.prService.isAvailable();
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const user = await this.getCurrentUser();
      return {
        success: true,
        info: { user },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // === URL Handling ===

  canHandleUrl(url: string): boolean {
    return url.includes("github.com") && !this.isEnterpriseUrl(url);
  }

  protected isEnterpriseUrl(_url: string): boolean {
    // Base implementation - not enterprise
    // Subclass (GitHubEnterpriseProvider) will override
    return false;
  }

  parseUrl(url: string): ParsedUrl | null {
    // Match various GitHub URL patterns
    const patterns = [
      // PR: github.com/owner/repo/pull/123
      /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
      // Issue: github.com/owner/repo/issues/123
      /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/,
      // Repo: github.com/owner/repo
      /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match?.[1] && match[2]) {
        const result: ParsedUrl = {
          provider: "github",
          host: "github.com",
          owner: match[1],
          repo: match[2],
        };

        if (url.includes("/pull/") && match[3]) {
          result.resourceType = "pr";
          result.resourceId = parseInt(match[3], 10);
        } else if (url.includes("/issues/") && match[3]) {
          result.resourceType = "issue";
          result.resourceId = parseInt(match[3], 10);
        }

        return result;
      }
    }
    return null;
  }

  buildUrl(parsed: Omit<ParsedUrl, "provider" | "host">): string {
    let url = `https://github.com/${parsed.owner}/${parsed.repo}`;
    if (parsed.resourceType === "pr" && parsed.resourceId) {
      url += `/pull/${parsed.resourceId}`;
    } else if (parsed.resourceType === "issue" && parsed.resourceId) {
      url += `/issues/${parsed.resourceId}`;
    }
    return url;
  }

  // === Repository Operations ===

  async getRepoInfo(owner: string, repo: string): Promise<RepoInfo> {
    const info = await this.repoService.getRepoInfo(owner, repo);
    const result: RepoInfo = {
      owner: info.owner,
      name: info.name,
      fullName: info.fullName,
      url: info.url,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      sshUrl: info.sshUrl,
      defaultBranch: info.defaultBranch,
      isPrivate: info.isPrivate,
      isFork: info.isFork,
      isArchived: false, // RepoService doesn't expose this yet
    };
    if (info.parent) {
      result.parent = info.parent;
    }
    return result;
  }

  async checkPermissions(owner: string, repo: string): Promise<PermissionCheck> {
    const perms = await this.repoService.checkPermissions(owner, repo);
    return {
      canPush: perms.canPush,
      canCreatePR: perms.canCreatePR,
      canMerge: perms.canPush, // Typically same as push
      isMember: perms.isMember,
      isOwner: perms.isOwner,
      isAdmin: perms.isOwner, // Approximation
    };
  }

  async getCurrentUser(): Promise<string> {
    return this.repoService.getCurrentUser();
  }

  async forkRepo(owner: string, repo: string): Promise<ForkResult> {
    const result = await this.repoService.forkRepo(owner, repo);
    const fork: RepoInfo = {
      owner: result.fork.owner,
      name: result.fork.name,
      fullName: result.fork.fullName,
      url: result.fork.url,
      cloneUrl: `https://github.com/${result.fork.owner}/${result.fork.name}.git`,
      sshUrl: result.fork.sshUrl,
      defaultBranch: result.fork.defaultBranch,
      isPrivate: result.fork.isPrivate,
      isFork: result.fork.isFork,
      isArchived: false,
    };
    if (result.fork.parent) {
      fork.parent = result.fork.parent;
    }
    return {
      fork,
      created: result.created,
    };
  }

  async syncFork(owner: string, repo: string, branch?: string): Promise<void> {
    return this.repoService.syncFork(owner, repo, branch);
  }

  async getProject(owner: string, repo: string): Promise<Project | null> {
    // Use gh API to get repository metadata for project scoring
    try {
      const json = await this.runGh([
        "api",
        `repos/${owner}/${repo}`,
        "--jq",
        `{
          id: .id,
          name: .name,
          full_name: .full_name,
          description: .description,
          html_url: .html_url,
          language: .language,
          stargazers_count: .stargazers_count,
          forks_count: .forks_count,
          open_issues_count: .open_issues_count,
          topics: .topics,
          license: .license.spdx_id,
          default_branch: .default_branch,
          pushed_at: .pushed_at
        }`,
      ]);

      const data = JSON.parse(json) as {
        id: number;
        name: string;
        full_name: string;
        description: string | null;
        html_url: string;
        language: string | null;
        stargazers_count: number;
        forks_count: number;
        open_issues_count: number;
        topics: string[];
        license: string | null;
        default_branch: string;
        pushed_at: string;
      };

      return {
        id: String(data.id),
        url: data.html_url,
        owner,
        name: data.name,
        fullName: data.full_name,
        description: data.description ?? "",
        language: data.language,
        stars: data.stargazers_count,
        forks: data.forks_count,
        openIssues: data.open_issues_count,
        topics: data.topics ?? [],
        license: data.license,
        defaultBranch: data.default_branch,
        lastActivityAt: new Date(data.pushed_at),
        hasContributingGuide: false, // Would need additional check
        automatedTools: [], // Would need additional analysis
      };
    } catch (error) {
      logger.debug(`Failed to get project info for ${owner}/${repo}: ${error}`);
      return null;
    }
  }

  // === Pull Request Operations ===

  async createPR(owner: string, repo: string, options: CreatePROptions): Promise<CreatePRResult> {
    const args = [
      "pr",
      "create",
      "--repo",
      `${owner}/${repo}`,
      "--head",
      options.headRepo ? `${options.headRepo}:${options.head}` : options.head,
      "--base",
      options.base,
      "--title",
      options.title,
      "--body",
      options.body,
    ];

    if (options.draft) {
      args.push("--draft");
    }

    if (options.labels && options.labels.length > 0) {
      args.push("--label", options.labels.join(","));
    }

    if (options.reviewers && options.reviewers.length > 0) {
      args.push("--reviewer", options.reviewers.join(","));
    }

    const result = await this.runGh(args);

    // gh pr create outputs the URL
    const url = result.trim();
    const prNumberMatch = url.match(/\/pull\/(\d+)/);
    const prNumber = prNumberMatch ? parseInt(prNumberMatch[1]!, 10) : 0;

    return {
      url,
      number: prNumber,
      id: `${owner}/${repo}#${prNumber}`,
    };
  }

  async getPR(owner: string, repo: string, prNumber: number): Promise<PullRequest> {
    return this.prService.getPR(owner, repo, prNumber);
  }

  async getReviews(owner: string, repo: string, prNumber: number): Promise<PRReview[]> {
    return this.prService.getReviews(owner, repo, prNumber);
  }

  async getComments(owner: string, repo: string, prNumber: number): Promise<PRComment[]> {
    return this.prService.getComments(owner, repo, prNumber);
  }

  async getChecks(owner: string, repo: string, prNumber: number): Promise<PRCheck[]> {
    return this.prService.getChecks(owner, repo, prNumber);
  }

  async getPRFeedback(owner: string, repo: string, prNumber: number): Promise<PRFeedbackData> {
    return this.prService.getPRFeedback(owner, repo, prNumber);
  }

  async updatePR(
    owner: string,
    repo: string,
    prNumber: number,
    updates: UpdatePROptions
  ): Promise<void> {
    const args = ["pr", "edit", String(prNumber), "--repo", `${owner}/${repo}`];

    if (updates.title) {
      args.push("--title", updates.title);
    }

    if (updates.body) {
      args.push("--body", updates.body);
    }

    await this.runGh(args);

    // State changes require separate command
    if (updates.state === "closed") {
      await this.runGh(["pr", "close", String(prNumber), "--repo", `${owner}/${repo}`]);
    } else if (updates.state === "open") {
      await this.runGh(["pr", "reopen", String(prNumber), "--repo", `${owner}/${repo}`]);
    }

    // Draft conversion
    if (updates.draft === true) {
      await this.runGh(["pr", "ready", String(prNumber), "--repo", `${owner}/${repo}`, "--undo"]);
    } else if (updates.draft === false) {
      await this.runGh(["pr", "ready", String(prNumber), "--repo", `${owner}/${repo}`]);
    }
  }

  async addComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
    await this.runGh([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      `${owner}/${repo}`,
      "--body",
      body,
    ]);
  }

  // === Protected Helpers ===

  protected runGh(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ghPath, args, {
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
          reject(new Error(`gh ${args.join(" ")} failed: ${stderr || stdout}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn gh: ${err.message}`));
      });
    });
  }
}
