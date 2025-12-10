import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { logger } from "../../infra/logger.js";
import { GitOperationError } from "../../infra/errors.js";
import { GitConfig } from "../../types/config.js";

export interface CloneResult {
  path: string;
  defaultBranch: string;
}

export interface BranchResult {
  name: string;
  created: boolean;
}

export interface CommitResult {
  hash: string;
  message: string;
}

export interface PushResult {
  branch: string;
  remote: string;
}

/**
 * GitOperations - Git operations for issue processing
 *
 * Handles cloning, branching, committing, and worktree management.
 * Uses git CLI directly for reliability and compatibility.
 */
export class GitOperations {
  private reposDir: string;
  private worktreesDir: string;

  constructor(
    private config: GitConfig,
    dataDir: string
  ) {
    this.reposDir = join(dataDir, "repos");
    this.worktreesDir = join(dataDir, "worktrees");

    // Ensure directories exist
    if (!existsSync(this.reposDir)) {
      mkdirSync(this.reposDir, { recursive: true });
    }
    if (!existsSync(this.worktreesDir)) {
      mkdirSync(this.worktreesDir, { recursive: true });
    }
  }

  /**
   * Clone a repository (or use existing clone)
   */
  async clone(repoUrl: string, owner: string, name: string): Promise<CloneResult> {
    const repoPath = join(this.reposDir, owner, name);

    if (existsSync(repoPath)) {
      logger.debug(`Repository already exists: ${repoPath}`);
      // Fetch latest changes
      await this.git(["fetch", "--all"], { cwd: repoPath });
      const defaultBranch = await this.getDefaultBranch(repoPath);
      return { path: repoPath, defaultBranch };
    }

    // Ensure owner directory exists
    const ownerDir = join(this.reposDir, owner);
    if (!existsSync(ownerDir)) {
      mkdirSync(ownerDir, { recursive: true });
    }

    logger.info(`Cloning ${repoUrl} to ${repoPath}`);
    await this.git(["clone", repoUrl, repoPath]);

    const defaultBranch = await this.getDefaultBranch(repoPath);
    return { path: repoPath, defaultBranch };
  }

  /**
   * Create a new branch for working on an issue
   */
  async createBranch(
    repoPath: string,
    issueNumber: number,
    issueTitle: string,
    baseBranch?: string
  ): Promise<BranchResult> {
    const base = baseBranch ?? (await this.getDefaultBranch(repoPath));

    // Generate branch name from issue
    const sanitizedTitle = issueTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);

    const branchName = `${this.config.branchPrefix}/issue-${issueNumber}-${sanitizedTitle}`;

    // Check if branch already exists
    const exists = await this.branchExists(repoPath, branchName);
    if (exists) {
      logger.debug(`Branch already exists: ${branchName}`);
      return { name: branchName, created: false };
    }

    // Create branch without checking it out (worktree will check it out)
    await this.git(["branch", branchName, `origin/${base}`], { cwd: repoPath });
    logger.info(`Created branch: ${branchName}`);

    return { name: branchName, created: true };
  }

  /**
   * Create a worktree for isolated issue work
   */
  async createWorktree(repoPath: string, branchName: string, issueId: string): Promise<string> {
    const worktreeName = `${basename(repoPath)}-${issueId}`;
    const worktreePath = join(this.worktreesDir, worktreeName);

    if (existsSync(worktreePath)) {
      logger.debug(`Worktree already exists: ${worktreePath}`);
      return worktreePath;
    }

    logger.info(`Creating worktree: ${worktreePath}`);
    await this.git(["worktree", "add", worktreePath, branchName], { cwd: repoPath });

    return worktreePath;
  }

  /**
   * Remove a worktree
   */
  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    if (!existsSync(worktreePath)) {
      logger.debug(`Worktree does not exist: ${worktreePath}`);
      return;
    }

    logger.info(`Removing worktree: ${worktreePath}`);
    await this.git(["worktree", "remove", worktreePath, "--force"], { cwd: repoPath });
  }

  /**
   * Stage and commit changes
   */
  async commit(
    cwd: string,
    message: string,
    options: { signoff?: boolean; allowEmpty?: boolean } = {}
  ): Promise<CommitResult> {
    // Stage all changes
    await this.git(["add", "-A"], { cwd });

    // Check if there are changes to commit
    const status = await this.git(["status", "--porcelain"], { cwd });
    if (!status.trim() && !options.allowEmpty) {
      throw new GitOperationError("No changes to commit");
    }

    // Build commit command
    const commitArgs = ["commit", "-m", message];
    if (options.signoff ?? this.config.commitSignoff) {
      commitArgs.push("--signoff");
    }
    if (options.allowEmpty) {
      commitArgs.push("--allow-empty");
    }

    await this.git(commitArgs, { cwd });

    // Get commit hash
    const hash = await this.git(["rev-parse", "HEAD"], { cwd });
    logger.info(`Committed: ${hash.slice(0, 8)} - ${message.split("\n")[0]}`);

    return { hash: hash.trim(), message };
  }

  /**
   * Push branch to remote
   */
  async push(
    cwd: string,
    branchName: string,
    options: { force?: boolean; setUpstream?: boolean } = {}
  ): Promise<PushResult> {
    const pushArgs = ["push"];

    if (options.setUpstream ?? true) {
      pushArgs.push("-u");
    }
    if (options.force) {
      pushArgs.push("--force-with-lease");
    }

    pushArgs.push("origin", branchName);

    await this.git(pushArgs, { cwd });
    logger.info(`Pushed branch: ${branchName}`);

    return { branch: branchName, remote: "origin" };
  }

  /**
   * Get current branch name
   */
  async getCurrentBranch(cwd: string): Promise<string> {
    const branch = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    return branch.trim();
  }

  /**
   * Get the default branch of a repository
   */
  async getDefaultBranch(repoPath: string): Promise<string> {
    try {
      // Try to get from origin/HEAD
      const ref = await this.git(["symbolic-ref", "refs/remotes/origin/HEAD"], {
        cwd: repoPath,
      });
      return ref.trim().replace("refs/remotes/origin/", "");
    } catch {
      // Fall back to configured default
      return this.config.defaultBranch;
    }
  }

  /**
   * Check if a branch exists
   */
  async branchExists(repoPath: string, branchName: string): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--verify", branchName], { cwd: repoPath });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a worktree exists
   */
  async worktreeExists(worktreePath: string): Promise<boolean> {
    return existsSync(worktreePath);
  }

  /**
   * Get HEAD commit SHA
   */
  async getHeadSha(cwd: string): Promise<string> {
    const sha = await this.git(["rev-parse", "HEAD"], { cwd });
    return sha.trim();
  }

  /**
   * Get list of changed files
   */
  async getChangedFiles(cwd: string, baseBranch?: string): Promise<string[]> {
    const base = baseBranch ?? (await this.getDefaultBranch(cwd));
    const diff = await this.git(["diff", "--name-only", `origin/${base}...HEAD`], { cwd });
    return diff
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);
  }

  /**
   * Get diff statistics (uncommitted changes + committed changes vs base)
   */
  async getDiffStats(
    cwd: string,
    baseBranch?: string
  ): Promise<{ files: number; insertions: number; deletions: number }> {
    const base = baseBranch ?? (await this.getDefaultBranch(cwd));

    // First check for uncommitted changes (working directory vs HEAD)
    const uncommittedStat = await this.git(["diff", "--shortstat"], { cwd });
    const stagedStat = await this.git(["diff", "--shortstat", "--staged"], { cwd });

    // Then check for committed changes vs base branch
    const committedStat = await this.git(["diff", "--shortstat", `origin/${base}...HEAD`], { cwd });

    const parseStat = (stat: string): { files: number; insertions: number; deletions: number } => {
      const match = stat.match(
        /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
      );
      if (!match) {
        return { files: 0, insertions: 0, deletions: 0 };
      }
      return {
        files: parseInt(match[1] ?? "0", 10),
        insertions: parseInt(match[2] ?? "0", 10),
        deletions: parseInt(match[3] ?? "0", 10),
      };
    };

    const uncommitted = parseStat(uncommittedStat);
    const staged = parseStat(stagedStat);
    const committed = parseStat(committedStat);

    // Return the largest diff (usually committed will be 0 before commit, uncommitted after)
    // But if there are commits ahead of origin, we should use committed
    if (committed.files > 0) {
      return committed;
    }

    // Combine uncommitted and staged for pre-commit stats
    return {
      files: Math.max(uncommitted.files, staged.files),
      insertions: uncommitted.insertions + staged.insertions,
      deletions: uncommitted.deletions + staged.deletions,
    };
  }

  /**
   * Reset working directory to clean state
   */
  async reset(cwd: string, hard: boolean = false): Promise<void> {
    if (hard) {
      await this.git(["reset", "--hard", "HEAD"], { cwd });
      await this.git(["clean", "-fd"], { cwd });
    } else {
      await this.git(["reset", "HEAD"], { cwd });
    }
    logger.debug(`Reset working directory: ${cwd}`);
  }

  /**
   * Clean up repository directory
   */
  async cleanup(repoPath: string): Promise<void> {
    if (existsSync(repoPath)) {
      // First, remove any worktrees
      try {
        const worktrees = await this.git(["worktree", "list", "--porcelain"], {
          cwd: repoPath,
        });
        const worktreePaths = worktrees
          .split("\n")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.replace("worktree ", ""))
          .filter((p) => p !== repoPath);

        for (const wt of worktreePaths) {
          try {
            await this.removeWorktree(repoPath, wt);
          } catch {
            // Force remove if worktree command fails
            if (existsSync(wt)) {
              rmSync(wt, { recursive: true, force: true });
            }
          }
        }
      } catch {
        // Ignore worktree listing errors
      }

      rmSync(repoPath, { recursive: true, force: true });
      logger.debug(`Cleaned up repository: ${repoPath}`);
    }
  }

  /**
   * Execute a git command
   */
  private git(args: string[], options: { cwd?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("git", args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
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
          const command = `git ${args.join(" ")}`;
          reject(new GitOperationError(`Git command failed: ${command}\n${stderr || stdout}`));
        }
      });

      proc.on("error", (error) => {
        reject(new GitOperationError(`Failed to spawn git: ${error.message}`, error));
      });
    });
  }
}
