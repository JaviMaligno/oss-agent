import { existsSync } from "node:fs";
import { logger } from "../../infra/logger.js";
import { ParallelConfig } from "../../types/config.js";
import { GitOperations } from "./git-operations.js";

export interface WorktreeInfo {
  path: string;
  branchName: string;
  issueId: string;
  projectId: string;
  status: WorktreeStatus;
  createdAt: Date;
}

export type WorktreeStatus = "active" | "completed" | "failed";

export interface ConflictResult {
  hasConflicts: boolean;
  conflicts: Array<{
    file: string;
    worktrees: string[];
  }>;
}

/**
 * WorktreeManager - Advanced worktree lifecycle management with tracking and limits.
 *
 * Wraps GitOperations with additional functionality:
 * - In-memory registry of active worktrees
 * - Resource limits (per-project and global)
 * - Conflict detection between parallel worktrees
 */
export class WorktreeManager {
  private registry: Map<string, WorktreeInfo> = new Map();

  constructor(
    private gitOps: GitOperations,
    private config: ParallelConfig
  ) {}

  /**
   * Create a new worktree for issue work
   */
  async create(
    repoPath: string,
    branchName: string,
    issueId: string,
    projectId: string
  ): Promise<WorktreeInfo> {
    // Check if we can create more worktrees
    const canCreate = this.canCreateMore(projectId);
    if (!canCreate.allowed) {
      throw new Error(`Cannot create worktree: ${canCreate.reason}`);
    }

    const path = await this.gitOps.createWorktree(repoPath, branchName, issueId);

    const info: WorktreeInfo = {
      path,
      branchName,
      issueId,
      projectId,
      status: "active",
      createdAt: new Date(),
    };

    this.registry.set(path, info);
    logger.debug(`WorktreeManager: registered worktree ${path} for issue ${issueId}`);

    return info;
  }

  /**
   * Remove a worktree
   */
  async remove(repoPath: string, worktreePath: string): Promise<void> {
    await this.gitOps.removeWorktree(repoPath, worktreePath);
    this.registry.delete(worktreePath);
    logger.debug(`WorktreeManager: removed worktree ${worktreePath}`);
  }

  /**
   * Mark worktree status (without removing)
   */
  markStatus(worktreePath: string, status: WorktreeStatus): void {
    const info = this.registry.get(worktreePath);
    if (info) {
      info.status = status;
      logger.debug(`WorktreeManager: marked ${worktreePath} as ${status}`);
    }
  }

  /**
   * List all registered worktrees
   */
  list(): WorktreeInfo[] {
    return Array.from(this.registry.values());
  }

  /**
   * List worktrees for a specific project
   */
  listByProject(projectId: string): WorktreeInfo[] {
    return this.list().filter((w) => w.projectId === projectId);
  }

  /**
   * Get a specific worktree by path
   */
  get(worktreePath: string): WorktreeInfo | null {
    return this.registry.get(worktreePath) ?? null;
  }

  /**
   * Get a worktree by issue ID
   */
  getByIssueId(issueId: string): WorktreeInfo | null {
    for (const info of this.registry.values()) {
      if (info.issueId === issueId) {
        return info;
      }
    }
    return null;
  }

  /**
   * Get all active worktrees
   */
  getActive(): WorktreeInfo[] {
    return this.list().filter((w) => w.status === "active");
  }

  /**
   * Check if more worktrees can be created
   */
  canCreateMore(projectId: string): { allowed: boolean; reason?: string } {
    const total = this.list().length;
    const forProject = this.listByProject(projectId).length;

    if (total >= this.config.maxWorktrees) {
      return {
        allowed: false,
        reason: `Global worktree limit reached (${total}/${this.config.maxWorktrees})`,
      };
    }

    if (forProject >= this.config.maxWorktreesPerProject) {
      return {
        allowed: false,
        reason: `Per-project worktree limit reached for ${projectId} (${forProject}/${this.config.maxWorktreesPerProject})`,
      };
    }

    return { allowed: true };
  }

  /**
   * Cleanup completed worktrees
   */
  async cleanupCompleted(repoPath: string): Promise<number> {
    let count = 0;
    const completed = this.list().filter((w) => w.status === "completed");

    for (const info of completed) {
      try {
        await this.remove(repoPath, info.path);
        count++;
      } catch (error) {
        logger.warn(`Failed to cleanup worktree ${info.path}: ${error}`);
      }
    }

    return count;
  }

  /**
   * Cleanup worktrees older than specified hours
   */
  async cleanupByAge(repoPath: string, maxAgeHours: number): Promise<number> {
    let count = 0;
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);

    for (const info of this.list()) {
      if (info.createdAt < cutoff) {
        try {
          await this.remove(repoPath, info.path);
          count++;
        } catch (error) {
          logger.warn(`Failed to cleanup old worktree ${info.path}: ${error}`);
        }
      }
    }

    return count;
  }

  /**
   * Detect file conflicts between worktrees.
   * Returns files that are modified in multiple worktrees.
   */
  async detectFileConflicts(worktreePaths: string[]): Promise<ConflictResult> {
    // Map of file -> list of worktrees that modified it
    const fileToWorktrees = new Map<string, string[]>();

    for (const worktreePath of worktreePaths) {
      if (!existsSync(worktreePath)) {
        continue;
      }

      try {
        const modifiedFiles = await this.gitOps.getModifiedFiles(worktreePath);

        for (const file of modifiedFiles) {
          const existing = fileToWorktrees.get(file) ?? [];
          existing.push(worktreePath);
          fileToWorktrees.set(file, existing);
        }
      } catch (error) {
        logger.warn(`Failed to get modified files for ${worktreePath}: ${error}`);
      }
    }

    // Find files modified in multiple worktrees
    const conflicts: Array<{ file: string; worktrees: string[] }> = [];

    for (const [file, worktrees] of fileToWorktrees) {
      if (worktrees.length > 1) {
        conflicts.push({ file, worktrees });
      }
    }

    return {
      hasConflicts: conflicts.length > 0,
      conflicts,
    };
  }

  /**
   * Sync registry with actual worktrees on disk.
   * Useful for recovering state after restart.
   */
  async syncWithDisk(repoPath: string, projectId: string): Promise<void> {
    try {
      const diskWorktrees = await this.gitOps.listWorktrees(repoPath);

      for (const wt of diskWorktrees) {
        if (!this.registry.has(wt.path) && existsSync(wt.path)) {
          // Found a worktree on disk not in registry - add it
          const info: WorktreeInfo = {
            path: wt.path,
            branchName: wt.branch ?? "unknown",
            issueId: this.extractIssueIdFromPath(wt.path),
            projectId,
            status: "active",
            createdAt: new Date(), // Unknown, use now
          };
          this.registry.set(wt.path, info);
          logger.debug(`WorktreeManager: synced worktree from disk: ${wt.path}`);
        }
      }

      // Remove registry entries for worktrees that no longer exist
      for (const path of this.registry.keys()) {
        if (!existsSync(path)) {
          this.registry.delete(path);
          logger.debug(`WorktreeManager: removed stale registry entry: ${path}`);
        }
      }
    } catch (error) {
      logger.warn(`Failed to sync worktrees with disk: ${error}`);
    }
  }

  private extractIssueIdFromPath(path: string): string {
    // Path format: <worktreesDir>/<repoName>-<issueId>
    const basename = path.split("/").pop() ?? "";
    const match = basename.match(/-([^/]+#\d+)$/);
    return match?.[1] ?? basename;
  }
}
