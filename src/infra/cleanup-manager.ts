import { rmSync, existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { logger } from "./logger.js";

export type CleanupTaskType = "worktree" | "temp-file" | "process" | "custom";

export interface CleanupTask {
  /** Unique identifier for this task */
  id: string;
  /** Type of cleanup task */
  type: CleanupTaskType;
  /** Description for logging */
  description: string;
  /** Path for file/directory cleanup */
  path?: string;
  /** Process ID for process cleanup */
  pid?: number;
  /** The cleanup function to execute */
  cleanup: () => Promise<void>;
  /** Priority (higher = cleanup first, default: 0) */
  priority?: number;
  /** Creation timestamp */
  createdAt: Date;
}

export interface CleanupResult {
  success: string[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * Manages cleanup tasks for resources that need to be released on shutdown
 *
 * The CleanupManager tracks resources (worktrees, temp files, processes) that
 * need to be cleaned up when the application exits. It ensures cleanup runs
 * on SIGINT/SIGTERM and provides manual cleanup methods.
 *
 * Usage:
 * ```typescript
 * const manager = CleanupManager.getInstance();
 *
 * // Register a cleanup task
 * const taskId = manager.register({
 *   id: 'worktree-123',
 *   type: 'worktree',
 *   description: 'Worktree at /path/to/worktree',
 *   path: '/path/to/worktree',
 *   cleanup: async () => {
 *     await removeWorktree('/path/to/worktree');
 *   }
 * });
 *
 * // When done (normal cleanup)
 * manager.unregister(taskId);
 *
 * // On shutdown, runAll() is called automatically
 * ```
 */
export class CleanupManager {
  private static instance: CleanupManager;
  private readonly tasks = new Map<string, CleanupTask>();
  private handlersInstalled = false;
  private isRunning = false;

  private constructor() {}

  static getInstance(): CleanupManager {
    if (!CleanupManager.instance) {
      CleanupManager.instance = new CleanupManager();
    }
    return CleanupManager.instance;
  }

  /**
   * Register a cleanup task
   *
   * @returns The task ID
   */
  register(task: Omit<CleanupTask, "createdAt">): string {
    const fullTask: CleanupTask = {
      ...task,
      priority: task.priority ?? 0,
      createdAt: new Date(),
    };

    this.tasks.set(task.id, fullTask);
    logger.debug(`Registered cleanup task: ${task.id} (${task.type})`, {
      description: task.description,
    });

    return task.id;
  }

  /**
   * Unregister a cleanup task (when resource is properly cleaned up)
   */
  unregister(taskId: string): boolean {
    const deleted = this.tasks.delete(taskId);
    if (deleted) {
      logger.debug(`Unregistered cleanup task: ${taskId}`);
    }
    return deleted;
  }

  /**
   * Check if a task is registered
   */
  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  /**
   * Get all registered tasks
   */
  getTasks(): CleanupTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get count of registered tasks
   */
  getTaskCount(): number {
    return this.tasks.size;
  }

  /**
   * Run all cleanup tasks
   *
   * Tasks are executed in priority order (higher priority first).
   * Errors are collected but don't stop other tasks from running.
   */
  async runAll(): Promise<CleanupResult> {
    if (this.isRunning) {
      logger.warn("Cleanup already in progress");
      return { success: [], failed: [] };
    }

    this.isRunning = true;
    const result: CleanupResult = { success: [], failed: [] };

    try {
      // Sort by priority (higher first)
      const sortedTasks = Array.from(this.tasks.values()).sort(
        (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
      );

      if (sortedTasks.length === 0) {
        return result;
      }

      logger.info(`Running ${sortedTasks.length} cleanup task(s)...`);

      for (const task of sortedTasks) {
        try {
          logger.debug(`Cleaning up: ${task.description}`);
          await task.cleanup();
          result.success.push(task.id);
          this.tasks.delete(task.id);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.warn(`Cleanup failed for ${task.id}: ${errorMsg}`);
          result.failed.push({ id: task.id, error: errorMsg });
        }
      }

      if (result.failed.length > 0) {
        logger.warn(`Cleanup completed with ${result.failed.length} failure(s)`);
      } else {
        logger.debug(`Cleanup completed successfully`);
      }
    } finally {
      this.isRunning = false;
    }

    return result;
  }

  /**
   * Install process exit handlers for automatic cleanup
   *
   * This should be called once at application startup for commands
   * that need cleanup on exit (like `run` or `work-parallel`).
   */
  installShutdownHandlers(): void {
    if (this.handlersInstalled) {
      return;
    }

    const handleShutdown = async (signal: string): Promise<void> => {
      logger.info(`Received ${signal}, running cleanup...`);

      try {
        await this.runAll();
      } catch (error) {
        logger.error("Cleanup error during shutdown", { error });
      }

      // Exit after cleanup
      process.exit(0);
    };

    // Note: These handlers run async cleanup, which may not complete
    // if the process is killed. For critical cleanup, consider
    // using synchronous cleanup or catching SIGTERM with a timeout.
    process.on("SIGINT", () => void handleShutdown("SIGINT"));
    process.on("SIGTERM", () => void handleShutdown("SIGTERM"));

    this.handlersInstalled = true;
    logger.debug("Shutdown handlers installed");
  }

  /**
   * Remove shutdown handlers (useful for testing)
   */
  removeShutdownHandlers(): void {
    // Note: We can't easily remove the specific handlers we added,
    // so this is primarily for testing purposes
    this.handlersInstalled = false;
  }

  /**
   * Clear all tasks without running them (useful for testing)
   */
  clear(): void {
    this.tasks.clear();
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

let taskIdCounter = 0;

function generateTaskId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++taskIdCounter}`;
}

/**
 * Register a worktree for cleanup
 *
 * @param repoPath - Path to the main repository
 * @param worktreePath - Path to the worktree to remove
 * @returns Task ID for unregistering
 */
export function registerWorktreeCleanup(repoPath: string, worktreePath: string): string {
  const taskId = generateTaskId("worktree");

  return CleanupManager.getInstance().register({
    id: taskId,
    type: "worktree",
    description: `Worktree at ${worktreePath}`,
    path: worktreePath,
    priority: 10, // Higher priority - clean worktrees before temp files
    cleanup: async () => {
      // Use git worktree remove
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("git", ["worktree", "remove", "--force", worktreePath], {
          cwd: repoPath,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stderr = "";
        proc.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        proc.on("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            // Worktree might already be removed, check if path exists
            if (!existsSync(worktreePath)) {
              resolve();
            } else {
              reject(new Error(`git worktree remove failed: ${stderr}`));
            }
          }
        });

        proc.on("error", reject);
      });
    },
  });
}

/**
 * Register a temporary file for cleanup
 *
 * @param filePath - Path to the temporary file
 * @returns Task ID for unregistering
 */
export function registerTempFileCleanup(filePath: string): string {
  const taskId = generateTaskId("temp-file");

  return CleanupManager.getInstance().register({
    id: taskId,
    type: "temp-file",
    description: `Temp file at ${filePath}`,
    path: filePath,
    priority: 0,
    cleanup: async () => {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    },
  });
}

/**
 * Register a temporary directory for cleanup
 *
 * @param dirPath - Path to the temporary directory
 * @returns Task ID for unregistering
 */
export function registerTempDirCleanup(dirPath: string): string {
  const taskId = generateTaskId("temp-dir");

  return CleanupManager.getInstance().register({
    id: taskId,
    type: "temp-file",
    description: `Temp directory at ${dirPath}`,
    path: dirPath,
    priority: 0,
    cleanup: async () => {
      if (existsSync(dirPath)) {
        rmSync(dirPath, { recursive: true, force: true });
      }
    },
  });
}

/**
 * Register a process for cleanup (will be killed on shutdown)
 *
 * @param pid - Process ID to kill
 * @param signal - Signal to send (default: SIGTERM)
 * @returns Task ID for unregistering
 */
export function registerProcessCleanup(
  pid: number,
  signal: globalThis.NodeJS.Signals = "SIGTERM"
): string {
  const taskId = generateTaskId("process");

  return CleanupManager.getInstance().register({
    id: taskId,
    type: "process",
    description: `Process ${pid}`,
    pid,
    priority: 20, // Highest priority - kill processes first
    cleanup: async () => {
      try {
        // Check if process exists
        process.kill(pid, 0);
        // Kill it
        process.kill(pid, signal);
      } catch {
        // Process doesn't exist, that's fine
      }
    },
  });
}

/**
 * Register a custom cleanup function
 *
 * @param id - Unique identifier for this cleanup
 * @param description - Human-readable description
 * @param cleanup - The cleanup function
 * @param priority - Priority (higher = runs first)
 * @returns Task ID for unregistering
 */
export function registerCustomCleanup(
  id: string,
  description: string,
  cleanup: () => Promise<void>,
  priority: number = 0
): string {
  return CleanupManager.getInstance().register({
    id,
    type: "custom",
    description,
    cleanup,
    priority,
  });
}
