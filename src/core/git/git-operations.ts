import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { logger } from "../../infra/logger.js";
import { GitOperationError, NetworkError } from "../../infra/errors.js";
import { GitConfig, HardeningConfig } from "../../types/config.js";
import { retry } from "../../infra/retry.js";
import { getCircuitBreaker, CIRCUIT_OPERATIONS } from "../../infra/circuit-breaker.js";

/** Default timeout for git network commands in milliseconds (5 minutes) */
const GIT_NETWORK_TIMEOUT_MS = 5 * 60 * 1000;

export interface CloneResult {
  path: string;
  defaultBranch: string;
  /** The remote to push to (origin for direct, fork for fork-based) */
  pushRemote: string;
  /** The owner of the push remote (may be different from upstream) */
  pushOwner: string;
  /** Whether this is using a fork */
  isFork: boolean;
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
  private hardeningConfig: HardeningConfig | undefined;

  constructor(
    private config: GitConfig,
    dataDir: string,
    hardeningConfig?: HardeningConfig
  ) {
    this.reposDir = join(dataDir, "repos");
    this.worktreesDir = join(dataDir, "worktrees");
    this.hardeningConfig = hardeningConfig;

    // Ensure directories exist
    if (!existsSync(this.reposDir)) {
      mkdirSync(this.reposDir, { recursive: true });
    }
    if (!existsSync(this.worktreesDir)) {
      mkdirSync(this.worktreesDir, { recursive: true });
    }
  }

  /**
   * Get the path where a repository would be stored.
   * Used for locking purposes before the repo is actually cloned.
   */
  getRepoPath(owner: string, name: string): string {
    return join(this.reposDir, owner, name);
  }

  /**
   * Clone a repository (or use existing clone)
   * For fork-based workflow, use cloneWithFork instead.
   */
  async clone(repoUrl: string, owner: string, name: string): Promise<CloneResult> {
    const repoPath = join(this.reposDir, owner, name);

    if (existsSync(repoPath)) {
      logger.debug(`Repository already exists: ${repoPath}`);
      // Fetch latest changes
      await this.git(["fetch", "--all"], { cwd: repoPath });
      const defaultBranch = await this.getDefaultBranch(repoPath);
      return {
        path: repoPath,
        defaultBranch,
        pushRemote: "origin",
        pushOwner: owner,
        isFork: false,
      };
    }

    // Ensure owner directory exists
    const ownerDir = join(this.reposDir, owner);
    if (!existsSync(ownerDir)) {
      mkdirSync(ownerDir, { recursive: true });
    }

    logger.info(`Cloning ${repoUrl} to ${repoPath}`);
    await this.git(["clone", repoUrl, repoPath]);

    const defaultBranch = await this.getDefaultBranch(repoPath);
    return {
      path: repoPath,
      defaultBranch,
      pushRemote: "origin",
      pushOwner: owner,
      isFork: false,
    };
  }

  /**
   * Clone a repository with fork support for contributing to upstream repos.
   * If the user doesn't have push access, creates/uses a fork.
   */
  async cloneWithFork(
    repoUrl: string,
    owner: string,
    name: string,
    forkOwner: string,
    forkUrl: string
  ): Promise<CloneResult> {
    const repoPath = join(this.reposDir, owner, name);

    if (existsSync(repoPath)) {
      logger.debug(`Repository already exists: ${repoPath}`);
      // Fetch latest changes from all remotes
      await this.git(["fetch", "--all"], { cwd: repoPath });

      // Ensure fork remote exists
      const remotes = await this.git(["remote"], { cwd: repoPath });
      if (!remotes.includes("fork")) {
        logger.info(`Adding fork remote: ${forkUrl}`);
        await this.git(["remote", "add", "fork", forkUrl], { cwd: repoPath });
        await this.git(["fetch", "fork"], { cwd: repoPath });
      }

      const defaultBranch = await this.getDefaultBranch(repoPath);
      return {
        path: repoPath,
        defaultBranch,
        pushRemote: "fork",
        pushOwner: forkOwner,
        isFork: true,
      };
    }

    // Ensure owner directory exists
    const ownerDir = join(this.reposDir, owner);
    if (!existsSync(ownerDir)) {
      mkdirSync(ownerDir, { recursive: true });
    }

    // Clone the upstream repository
    logger.info(`Cloning ${repoUrl} to ${repoPath}`);
    await this.git(["clone", repoUrl, repoPath]);

    // Add fork as a separate remote
    logger.info(`Adding fork remote: ${forkUrl}`);
    await this.git(["remote", "add", "fork", forkUrl], { cwd: repoPath });
    await this.git(["fetch", "fork"], { cwd: repoPath });

    const defaultBranch = await this.getDefaultBranch(repoPath);
    return {
      path: repoPath,
      defaultBranch,
      pushRemote: "fork",
      pushOwner: forkOwner,
      isFork: true,
    };
  }

  /**
   * Create a new branch for working on an issue
   *
   * Handles existing branches according to config.existingBranchStrategy:
   * - "auto-clean": Delete existing branch (local + remote) and start fresh
   *   NOTE: Will NOT delete remote branch if there's an open PR to prevent PR closure
   * - "reuse": Reuse existing branch if found
   * - "suffix": Create a new branch with numeric suffix (e.g., branch-2, branch-3)
   * - "fail": Fail if branch already exists
   *
   * @param repoPath - Path to the repository
   * @param issueNumber - Issue number for branch naming
   * @param issueTitle - Issue title for branch naming
   * @param baseBranch - Base branch to create from (defaults to default branch)
   * @param repoInfo - Optional owner/repo info for PR checking during auto-clean
   */
  async createBranch(
    repoPath: string,
    issueNumber: number,
    issueTitle: string,
    baseBranch?: string,
    repoInfo?: { owner: string; repo: string }
  ): Promise<BranchResult> {
    const base = baseBranch ?? (await this.getDefaultBranch(repoPath));

    // Generate branch name from issue
    const sanitizedTitle = issueTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);

    const baseBranchName = `${this.config.branchPrefix}/issue-${issueNumber}-${sanitizedTitle}`;
    let branchName = baseBranchName;

    // Check if branch already exists locally
    const existsLocal = await this.branchExists(repoPath, branchName);

    // Check if branch exists on remotes (origin and fork)
    const existsOnOrigin = await this.remoteBranchExists(repoPath, "origin", branchName);
    const existsOnFork = await this.remoteBranchExists(repoPath, "fork", branchName);

    const exists = existsLocal || existsOnOrigin || existsOnFork;

    if (exists) {
      const strategy = this.config.existingBranchStrategy ?? "auto-clean";

      if (strategy === "fail") {
        throw new GitOperationError(
          `Branch already exists: ${branchName}. ` +
            `Configure git.existingBranchStrategy to "auto-clean", "reuse", or "suffix" to handle this.`
        );
      }

      if (strategy === "reuse") {
        logger.info(`Reusing existing branch: ${branchName}`);
        // Make sure local branch exists (might only be on remote)
        if (!existsLocal && (existsOnOrigin || existsOnFork)) {
          const remote = existsOnFork ? "fork" : "origin";
          await this.git(["branch", branchName, `${remote}/${branchName}`], { cwd: repoPath });
        }
        return { name: branchName, created: false };
      }

      if (strategy === "suffix") {
        // Find the next available suffix
        let suffix = 2;
        while (suffix <= 100) {
          const candidateName = `${baseBranchName}-${suffix}`;
          const candidateExistsLocal = await this.branchExists(repoPath, candidateName);
          const candidateExistsFork = await this.remoteBranchExists(
            repoPath,
            "fork",
            candidateName
          );
          const candidateExistsOrigin = await this.remoteBranchExists(
            repoPath,
            "origin",
            candidateName
          );

          if (!candidateExistsLocal && !candidateExistsFork && !candidateExistsOrigin) {
            branchName = candidateName;
            logger.info(`Using suffixed branch name: ${branchName}`);
            break;
          }
          suffix++;
        }

        if (suffix > 100) {
          throw new GitOperationError(
            `Could not find available branch name after 100 attempts for: ${baseBranchName}`
          );
        }
      } else {
        // strategy === "auto-clean"
        logger.info(`Auto-cleaning existing branch: ${branchName}`);

        // Delete local branch if exists
        if (existsLocal) {
          try {
            await this.git(["branch", "-D", branchName], { cwd: repoPath });
            logger.debug(`Deleted local branch: ${branchName}`);
          } catch {
            // May fail if branch is checked out in a worktree - try to remove worktree first
            logger.debug(`Could not delete local branch, checking for worktrees...`);
            try {
              const worktrees = await this.listWorktrees(repoPath);
              const blockingWt = worktrees.find(
                (wt) => wt.branch === `refs/heads/${branchName}` || wt.branch === branchName
              );

              if (blockingWt) {
                logger.info(`Removing blocking worktree: ${blockingWt.path}`);
                await this.removeWorktree(repoPath, blockingWt.path);
                // Retry branch deletion
                await this.git(["branch", "-D", branchName], { cwd: repoPath });
                logger.debug(`Deleted local branch after worktree cleanup: ${branchName}`);
              }
            } catch (e) {
              logger.warn(`Failed to clean up blocking worktree: ${e}`);
            }
          }
        }

        // Delete from fork remote if exists, but ONLY if there's no open PR
        // Deleting the head branch of a PR will close it
        if (existsOnFork) {
          let hasOpenPR = false;
          if (repoInfo) {
            // Check if there's an open PR for this branch (targeting upstream)
            hasOpenPR = await this.hasOpenPR(repoInfo.owner, repoInfo.repo, branchName);
          }

          if (hasOpenPR) {
            logger.warn(
              `Skipping remote branch deletion: open PR exists for ${branchName}. ` +
                `Using "reuse" strategy instead to preserve the PR.`
            );
            // Make sure local branch exists (might only be on remote)
            if (!existsLocal) {
              await this.git(["branch", branchName, `fork/${branchName}`], { cwd: repoPath });
            }
            return { name: branchName, created: false };
          }

          try {
            await this.git(["push", "fork", "--delete", branchName], { cwd: repoPath });
            logger.debug(`Deleted branch from fork: ${branchName}`);
          } catch (error) {
            logger.debug(`Could not delete branch from fork: ${error}`);
          }
        }

        // Note: We don't delete from origin - we typically don't have push access there
      }
    }

    // Create branch without checking it out (worktree will check it out)
    await this.git(["branch", branchName, `origin/${base}`], { cwd: repoPath });
    logger.info(`Created branch: ${branchName}`);

    return { name: branchName, created: true };
  }

  /**
   * Check if a branch exists on a remote
   */
  async remoteBranchExists(repoPath: string, remote: string, branchName: string): Promise<boolean> {
    try {
      const result = await this.git(["ls-remote", "--heads", remote, branchName], {
        cwd: repoPath,
      });
      return result.trim().length > 0;
    } catch {
      // Remote might not exist (e.g., "fork" when not using fork workflow)
      return false;
    }
  }

  /**
   * Create a worktree for isolated issue work
   */
  async createWorktree(repoPath: string, branchName: string, issueId: string): Promise<string> {
    // Sanitize issueId for file path: replace # and / with - to avoid Vite issues
    // e.g., "owner/repo#123" becomes "owner-repo-123"
    const sanitizedIssueId = issueId.replace(/[#/]/g, "-");
    const worktreeName = `${basename(repoPath)}-${sanitizedIssueId}`;
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
   * Add a remote to the repository
   */
  async addRemote(repoPath: string, name: string, url: string): Promise<void> {
    // Check if remote already exists
    try {
      const remotes = await this.git(["remote"], { cwd: repoPath });
      if (remotes.includes(name)) {
        logger.debug(`Remote ${name} already exists`);
        return;
      }
    } catch {
      // Ignore errors, try to add anyway
    }

    logger.info(`Adding remote: ${name} -> ${url}`);
    await this.git(["remote", "add", name, url], { cwd: repoPath });
  }

  /**
   * Fetch from a remote
   */
  async fetch(repoPath: string, remote: string = "origin"): Promise<void> {
    logger.debug(`Fetching from ${remote}`);
    await this.git(["fetch", remote], { cwd: repoPath });
  }

  /**
   * Check if the current branch needs rebase against a base branch
   * Returns true if the base branch has commits not in the current branch
   */
  async needsRebase(repoPath: string, baseBranch: string): Promise<boolean> {
    try {
      // Count commits in base that are not in HEAD
      const result = await this.git(["rev-list", "--count", `HEAD..origin/${baseBranch}`], {
        cwd: repoPath,
      });
      const count = parseInt(result.trim(), 10);
      return count > 0;
    } catch {
      // If the command fails, assume we might need rebase
      return true;
    }
  }

  /**
   * Attempt to rebase current branch onto a base branch
   * Returns true if rebase succeeded, false if there were conflicts
   */
  async rebase(
    repoPath: string,
    baseBranch: string,
    remote: string = "origin"
  ): Promise<{ success: boolean; hasConflicts: boolean }> {
    try {
      await this.git(["rebase", `${remote}/${baseBranch}`], { cwd: repoPath });
      return { success: true, hasConflicts: false };
    } catch (error) {
      // Check if it's a conflict
      const hasConflicts = await this.hasConflicts(repoPath);
      if (hasConflicts) {
        return { success: false, hasConflicts: true };
      }
      // Other error
      throw error;
    }
  }

  /**
   * Check if there are unresolved merge/rebase conflicts
   */
  async hasConflicts(repoPath: string): Promise<boolean> {
    try {
      const status = await this.git(["status", "--porcelain"], { cwd: repoPath });
      // Conflict markers: UU, AA, DD, AU, UA, DU, UD
      return status.split("\n").some((line) => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(line));
    } catch {
      return false;
    }
  }

  /**
   * Get list of files with conflicts
   */
  async getConflictedFiles(repoPath: string): Promise<string[]> {
    const status = await this.git(["status", "--porcelain"], { cwd: repoPath });
    return status
      .split("\n")
      .filter((line) => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(line))
      .map((line) => line.slice(3).trim());
  }

  /**
   * Abort an in-progress rebase
   */
  async abortRebase(repoPath: string): Promise<void> {
    try {
      await this.git(["rebase", "--abort"], { cwd: repoPath });
    } catch {
      // May not be in a rebase state
    }
  }

  /**
   * Continue rebase after conflicts are resolved
   */
  async continueRebase(repoPath: string): Promise<boolean> {
    try {
      await this.git(["rebase", "--continue"], { cwd: repoPath });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Mark a file as resolved during rebase
   */
  async markResolved(repoPath: string, filePath: string): Promise<void> {
    await this.git(["add", filePath], { cwd: repoPath });
  }

  /**
   * Create a worktree from a specific remote ref (for external PRs)
   */
  async createWorktreeFromRef(
    repoPath: string,
    branchName: string,
    identifier: string,
    remoteRef: string
  ): Promise<string> {
    const sanitizedId = identifier.replace(/[#/]/g, "-");
    const worktreeName = `${basename(repoPath)}-${sanitizedId}`;
    const worktreePath = join(this.worktreesDir, worktreeName);

    if (existsSync(worktreePath)) {
      logger.debug(`Worktree already exists: ${worktreePath}`);
      // Update to latest
      await this.git(["pull", "--rebase"], { cwd: worktreePath });
      return worktreePath;
    }

    logger.info(`Creating worktree from ${remoteRef}: ${worktreePath}`);

    // Create a local branch tracking the remote ref
    try {
      await this.git(["branch", "-D", branchName], { cwd: repoPath });
    } catch {
      // Branch may not exist, that's fine
    }

    // Create branch from remote ref
    await this.git(["branch", branchName, remoteRef], { cwd: repoPath });

    // Create worktree
    await this.git(["worktree", "add", worktreePath, branchName], { cwd: repoPath });

    return worktreePath;
  }

  /**
   * Check if there are uncommitted changes (staged or unstaged)
   */
  async hasUncommittedChanges(cwd: string): Promise<boolean> {
    const status = await this.git(["status", "--porcelain"], { cwd });
    return status.trim().length > 0;
  }

  /**
   * Stage all changes (without committing)
   */
  async stageAll(cwd: string): Promise<void> {
    await this.git(["add", "-A"], { cwd });
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
    options: {
      force?: boolean;
      setUpstream?: boolean;
      remote?: string;
      skipVerification?: boolean;
    } = {}
  ): Promise<PushResult> {
    const remote = options.remote ?? "origin";
    const pushArgs = ["push"];

    if (options.setUpstream ?? true) {
      pushArgs.push("-u");
    }
    if (options.force) {
      pushArgs.push("--force-with-lease");
    }
    if (options.skipVerification) {
      pushArgs.push("--no-verify");
    }

    pushArgs.push(remote, branchName);

    await this.git(pushArgs, { cwd });
    logger.info(`Pushed branch: ${branchName}`);

    return { branch: branchName, remote: options.remote ?? "origin" };
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
   * Get list of files modified in the worktree compared to base branch.
   * Includes both committed and uncommitted changes.
   * Used for conflict detection between parallel worktrees.
   */
  async getModifiedFiles(worktreePath: string, baseBranch?: string): Promise<string[]> {
    const base = baseBranch ?? (await this.getDefaultBranch(worktreePath));

    // Get committed changes vs base branch
    const committedFiles = await this.git(["diff", "--name-only", `origin/${base}...HEAD`], {
      cwd: worktreePath,
    });

    // Get uncommitted changes (staged + unstaged)
    const uncommittedFiles = await this.git(["diff", "--name-only", "HEAD"], {
      cwd: worktreePath,
    });

    const stagedFiles = await this.git(["diff", "--name-only", "--staged"], {
      cwd: worktreePath,
    });

    // Combine all modified files into a unique set
    const allFiles = new Set<string>();

    for (const output of [committedFiles, uncommittedFiles, stagedFiles]) {
      for (const file of output.trim().split("\n")) {
        if (file.length > 0) {
          allFiles.add(file);
        }
      }
    }

    return Array.from(allFiles);
  }

  /**
   * List all worktrees for a repository
   */
  async listWorktrees(repoPath: string): Promise<
    Array<{
      path: string;
      head: string;
      branch: string | null;
    }>
  > {
    const output = await this.git(["worktree", "list", "--porcelain"], { cwd: repoPath });
    const worktrees: Array<{ path: string; head: string; branch: string | null }> = [];

    let current: { path?: string; head?: string; branch?: string | null } = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) {
          worktrees.push({
            path: current.path,
            head: current.head ?? "",
            branch: current.branch ?? null,
          });
        }
        current = { path: line.replace("worktree ", "") };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.replace("HEAD ", "");
      } else if (line.startsWith("branch ")) {
        current.branch = line.replace("branch refs/heads/", "");
      } else if (line === "detached") {
        current.branch = null;
      }
    }

    // Add the last worktree
    if (current.path) {
      worktrees.push({
        path: current.path,
        head: current.head ?? "",
        branch: current.branch ?? null,
      });
    }

    // Filter out the main repo (first entry is usually the main worktree)
    return worktrees.filter((wt) => wt.path !== repoPath);
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
  private async git(args: string[], options: { cwd?: string } = {}): Promise<string> {
    // Commands that involve network and are safe to retry
    const networkCommands = ["fetch", "push", "pull", "clone", "ls-remote"];
    const isNetworkCommand = args.length > 0 && networkCommands.includes(args[0] ?? "");

    const executeGit = (): Promise<string> => {
      return new Promise((resolve, reject) => {
        const proc = spawn("git", args, {
          cwd: options.cwd,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        // Add timeout for network commands to prevent hanging
        if (isNetworkCommand) {
          timeoutId = setTimeout(() => {
            timedOut = true;
            proc.kill("SIGTERM");
            // Force kill after 5 seconds if still running
            setTimeout(() => {
              if (!proc.killed) {
                proc.kill("SIGKILL");
              }
            }, 5000);
          }, GIT_NETWORK_TIMEOUT_MS);
        }

        const cleanup = (): void => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        };

        proc.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        proc.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        proc.on("close", (code) => {
          cleanup();
          if (timedOut) {
            const command = `git ${args.join(" ")}`;
            reject(
              new NetworkError(
                `Git command timed out after ${GIT_NETWORK_TIMEOUT_MS / 1000}s: ${command}`
              )
            );
            return;
          }
          if (code === 0) {
            resolve(stdout);
          } else {
            const command = `git ${args.join(" ")}`;
            // Check if it's a network error
            const isNetwork =
              stderr.includes("Could not resolve host") ||
              stderr.includes("Connection timed out") ||
              stderr.includes("Connection refused") ||
              stderr.includes("unable to access") ||
              stderr.includes("SSL") ||
              stderr.includes("failed to connect");

            if (isNetwork) {
              reject(new NetworkError(`Git command failed: ${command}\n${stderr || stdout}`));
            } else {
              reject(new GitOperationError(`Git command failed: ${command}\n${stderr || stdout}`));
            }
          }
        });

        proc.on("error", (error) => {
          cleanup();
          reject(new GitOperationError(`Failed to spawn git: ${error.message}`, error));
        });
      });
    };

    // For network commands, use retry with circuit breaker
    if (isNetworkCommand) {
      const circuitBreaker = getCircuitBreaker(CIRCUIT_OPERATIONS.GIT_OPERATIONS, {
        failureThreshold: this.hardeningConfig?.circuitBreaker.failureThreshold ?? 5,
        successThreshold: this.hardeningConfig?.circuitBreaker.successThreshold ?? 2,
        openDurationMs: this.hardeningConfig?.circuitBreaker.openDurationMs ?? 60000,
      });

      const retryConfig = this.hardeningConfig?.retry;

      return circuitBreaker.execute(() =>
        retry(executeGit, {
          maxRetries: retryConfig?.maxRetries ?? 3,
          baseDelayMs: retryConfig?.baseDelayMs ?? 1000,
          maxDelayMs: retryConfig?.maxDelayMs ?? 30000,
          jitter: retryConfig?.enableJitter ?? true,
          shouldRetry: (error) => error instanceof NetworkError,
          onRetry: (error, attempt, delayMs) => {
            logger.warn(`Git retry ${attempt}: ${error.message}, waiting ${delayMs}ms`);
          },
        })
      );
    }

    // For non-network commands, execute directly
    return executeGit();
  }

  /**
   * Execute a gh CLI command
   */
  private async gh(args: string[], _options: { cwd?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("gh", args, {
        cwd: _options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      // Add timeout for gh commands to prevent hanging
      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, 5000);
      }, GIT_NETWORK_TIMEOUT_MS);

      const cleanup = (): void => {
        clearTimeout(timeoutId);
      };

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        cleanup();
        if (timedOut) {
          reject(
            new Error(
              `gh command timed out after ${GIT_NETWORK_TIMEOUT_MS / 1000}s: gh ${args.join(" ")}`
            )
          );
          return;
        }
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`gh command failed: gh ${args.join(" ")}\n${stderr || stdout}`));
        }
      });

      proc.on("error", (error) => {
        cleanup();
        reject(new Error(`Failed to spawn gh: ${error.message}`));
      });
    });
  }

  /**
   * Check if there's an open PR for a branch in a repository
   * Uses gh CLI to query GitHub API
   */
  async hasOpenPR(owner: string, repo: string, branchName: string): Promise<boolean> {
    try {
      const result = await this.gh([
        "pr",
        "list",
        "--repo",
        `${owner}/${repo}`,
        "--head",
        branchName,
        "--state",
        "open",
        "--json",
        "number",
      ]);
      const prs = JSON.parse(result.trim() || "[]") as Array<{ number: number }>;
      if (prs.length > 0) {
        logger.debug(`Found open PR for branch ${branchName}: #${prs[0]?.number}`);
        return true;
      }
      return false;
    } catch (error) {
      logger.debug(`Could not check for open PRs: ${error}`);
      // If we can't check, assume there might be a PR to be safe
      return false;
    }
  }
}
