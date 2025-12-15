import { spawn } from "node:child_process";
import { logger } from "../../infra/logger.js";
import { RateLimitError, NetworkError } from "../../infra/errors.js";
import { retryWithRateLimit } from "../../infra/retry.js";
import { getCircuitBreaker, CIRCUIT_OPERATIONS } from "../../infra/circuit-breaker.js";
import type { HardeningConfig } from "../../types/config.js";

export interface RepoInfo {
  owner: string;
  name: string;
  fullName: string;
  url: string;
  sshUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
  isFork: boolean;
  parent?: {
    owner: string;
    name: string;
    fullName: string;
  };
}

export interface ForkResult {
  fork: RepoInfo;
  created: boolean;
}

export interface PermissionCheck {
  canPush: boolean;
  canCreatePR: boolean;
  isMember: boolean;
  isOwner: boolean;
}

/**
 * RepoService - GitHub repository operations including fork management
 */
export class RepoService {
  private hardeningConfig: HardeningConfig | undefined;

  constructor(hardeningConfig?: HardeningConfig) {
    this.hardeningConfig = hardeningConfig;
  }
  /**
   * Get repository information
   */
  async getRepoInfo(owner: string, repo: string): Promise<RepoInfo> {
    const result = await this.gh([
      "repo",
      "view",
      `${owner}/${repo}`,
      "--json",
      "owner,name,url,sshUrl,defaultBranchRef,isPrivate,isFork,parent",
    ]);

    const data = JSON.parse(result) as {
      owner: { login: string };
      name: string;
      url: string;
      sshUrl: string;
      defaultBranchRef: { name: string };
      isPrivate: boolean;
      isFork: boolean;
      parent?: { owner: { login: string }; name: string };
    };

    const info: RepoInfo = {
      owner: data.owner.login,
      name: data.name,
      fullName: `${data.owner.login}/${data.name}`,
      url: data.url,
      sshUrl: data.sshUrl,
      defaultBranch: data.defaultBranchRef.name,
      isPrivate: data.isPrivate,
      isFork: data.isFork,
    };

    if (data.parent) {
      info.parent = {
        owner: data.parent.owner.login,
        name: data.parent.name,
        fullName: `${data.parent.owner.login}/${data.parent.name}`,
      };
    }

    return info;
  }

  /**
   * Check if the current user has push access to a repository
   */
  async checkPermissions(owner: string, repo: string): Promise<PermissionCheck> {
    try {
      // Get current user
      const whoami = await this.gh(["api", "user", "--jq", ".login"]);
      const currentUser = whoami.trim();

      // Check if user is owner
      const isOwner = currentUser.toLowerCase() === owner.toLowerCase();

      // Check repository permissions
      const permResult = await this.gh(["api", `repos/${owner}/${repo}`, "--jq", ".permissions"]);

      const permissions = JSON.parse(permResult) as {
        admin?: boolean;
        push?: boolean;
        pull?: boolean;
      };

      return {
        canPush: permissions.push ?? false,
        canCreatePR: permissions.pull ?? true, // Can create PR if can read
        isMember: permissions.push ?? false,
        isOwner,
      };
    } catch (error) {
      logger.debug(`Permission check failed: ${error}`);
      return {
        canPush: false,
        canCreatePR: true, // Assume can create PR via fork
        isMember: false,
        isOwner: false,
      };
    }
  }

  /**
   * Get the current authenticated user
   */
  async getCurrentUser(): Promise<string> {
    const result = await this.gh(["api", "user", "--jq", ".login"]);
    return result.trim();
  }

  /**
   * Fork a repository (or return existing fork)
   */
  async forkRepo(owner: string, repo: string): Promise<ForkResult> {
    const currentUser = await this.getCurrentUser();

    // Check if fork already exists
    try {
      const existingFork = await this.getRepoInfo(currentUser, repo);
      if (existingFork.isFork && existingFork.parent?.fullName === `${owner}/${repo}`) {
        logger.info(`Using existing fork: ${existingFork.fullName}`);
        return { fork: existingFork, created: false };
      }
    } catch {
      // Fork doesn't exist, will create
    }

    logger.info(`Forking ${owner}/${repo}...`);

    // Create fork
    const forkResult = await this.gh([
      "repo",
      "fork",
      `${owner}/${repo}`,
      "--clone=false",
      "--json",
      "owner,name,url,sshUrl,defaultBranchRef,isPrivate,isFork,parent",
    ]);

    const data = JSON.parse(forkResult) as {
      owner: { login: string };
      name: string;
      url: string;
      sshUrl: string;
      defaultBranchRef: { name: string };
      isPrivate: boolean;
      isFork: boolean;
      parent?: { owner: { login: string }; name: string };
    };

    const fork: RepoInfo = {
      owner: data.owner.login,
      name: data.name,
      fullName: `${data.owner.login}/${data.name}`,
      url: data.url,
      sshUrl: data.sshUrl,
      defaultBranch: data.defaultBranchRef.name,
      isPrivate: data.isPrivate,
      isFork: data.isFork,
    };

    if (data.parent) {
      fork.parent = {
        owner: data.parent.owner.login,
        name: data.parent.name,
        fullName: `${data.parent.owner.login}/${data.parent.name}`,
      };
    }

    logger.success(`Created fork: ${fork.fullName}`);
    return { fork, created: true };
  }

  /**
   * Check if user has an existing fork of a repository
   */
  async findExistingFork(owner: string, repo: string): Promise<RepoInfo | null> {
    const currentUser = await this.getCurrentUser();

    try {
      const fork = await this.getRepoInfo(currentUser, repo);
      if (fork.isFork && fork.parent?.fullName === `${owner}/${repo}`) {
        return fork;
      }
    } catch {
      // No fork found
    }

    return null;
  }

  /**
   * Sync fork with upstream
   */
  async syncFork(owner: string, repo: string, branch?: string): Promise<void> {
    const targetBranch = branch ?? "main";

    logger.info(`Syncing fork ${owner}/${repo} with upstream...`);

    await this.gh(["repo", "sync", `${owner}/${repo}`, "--branch", targetBranch]);

    logger.success(`Synced fork with upstream`);
  }

  /**
   * Execute gh CLI command with retry and circuit breaker
   */
  private async gh(args: string[]): Promise<string> {
    const circuitBreaker = getCircuitBreaker(CIRCUIT_OPERATIONS.GITHUB_API, {
      failureThreshold: this.hardeningConfig?.circuitBreaker.failureThreshold ?? 5,
      successThreshold: this.hardeningConfig?.circuitBreaker.successThreshold ?? 2,
      openDurationMs: this.hardeningConfig?.circuitBreaker.openDurationMs ?? 60000,
    });

    const retryConfig = this.hardeningConfig?.retry;

    return circuitBreaker.execute(() =>
      retryWithRateLimit(() => this.executeGh(args), {
        maxRetries: retryConfig?.maxRetries ?? 3,
        baseDelayMs: retryConfig?.baseDelayMs ?? 1000,
        maxDelayMs: retryConfig?.maxDelayMs ?? 30000,
        jitter: retryConfig?.enableJitter ?? true,
        shouldRetry: (error) => {
          if (error instanceof RateLimitError) return true;
          if (error instanceof NetworkError) return true;
          if (error.message.includes("rate limit")) return true;
          if (error.message.includes("network")) return true;
          return false;
        },
        onRetry: (error, attempt, delayMs) => {
          logger.warn(`GitHub API retry ${attempt}: ${error.message}, waiting ${delayMs}ms`);
        },
      })
    );
  }

  /**
   * Execute gh CLI command (internal)
   */
  private executeGh(args: string[]): Promise<string> {
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
          // Check for rate limit errors
          if (stderr.includes("rate limit") || stderr.includes("API rate limit")) {
            // Try to extract retry-after from error message
            const retryMatch = stderr.match(/retry after (\d+)/i);
            const retryAfter = retryMatch ? parseInt(retryMatch[1] ?? "60", 10) : undefined;
            reject(new RateLimitError(`GitHub API rate limited: ${stderr}`, retryAfter));
          } else if (
            stderr.includes("network") ||
            stderr.includes("connection") ||
            stderr.includes("timeout")
          ) {
            reject(new NetworkError(`gh ${args.join(" ")} failed: ${stderr}`));
          } else {
            reject(new Error(`gh ${args.join(" ")} failed: ${stderr}`));
          }
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn gh: ${err.message}`));
      });
    });
  }
}
