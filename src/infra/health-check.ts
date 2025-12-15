import { freemem, totalmem } from "node:os";
import { statfsSync } from "node:fs";
import { logger } from "./logger.js";
import type { AIProvider } from "../core/ai/types.js";

export type HealthStatus = "ok" | "warning" | "critical" | "unavailable";

export interface DiskSpaceCheck {
  status: HealthStatus;
  availableGb: number;
  usedPercent: number;
  path: string;
}

export interface MemoryCheck {
  status: HealthStatus;
  usedMb: number;
  availableMb: number;
  usedPercent: number;
}

export interface AIProviderCheck {
  status: HealthStatus;
  lastCheck: Date;
  latencyMs?: number;
  error?: string;
}

export interface WorktreeCheck {
  count: number;
  limit: number;
  status: HealthStatus;
}

export interface HealthCheckResult {
  healthy: boolean;
  overallStatus: HealthStatus;
  checks: {
    diskSpace: DiskSpaceCheck;
    memory: MemoryCheck;
    aiProvider: AIProviderCheck | undefined;
    worktrees: WorktreeCheck | undefined;
  };
  timestamp: Date;
}

export interface HealthCheckOptions {
  /** How often to run periodic health checks in ms (default: 60000) */
  intervalMs?: number;
  /** Disk space warning threshold in GB (default: 1.0) */
  diskWarningThresholdGb?: number;
  /** Disk space critical threshold in GB (default: 0.5) */
  diskCriticalThresholdGb?: number;
  /** Memory warning threshold in MB available (default: 100) */
  memoryWarningThresholdMb?: number;
  /** Callback when health status changes to warning */
  onWarning?: ((result: HealthCheckResult) => void) | undefined;
  /** Callback when health status changes to critical */
  onCritical?: ((result: HealthCheckResult) => void) | undefined;
  /** Path to check disk space for (default: process.cwd()) */
  diskPath?: string;
}

const DEFAULT_OPTIONS: Required<Omit<HealthCheckOptions, "onWarning" | "onCritical">> = {
  intervalMs: 60000,
  diskWarningThresholdGb: 1.0,
  diskCriticalThresholdGb: 0.5,
  memoryWarningThresholdMb: 100,
  diskPath: process.cwd(),
};

/**
 * Health checker for monitoring system resources during long-running operations
 *
 * Monitors:
 * - Disk space (warning and critical thresholds)
 * - Memory usage
 * - AI provider availability (optional)
 *
 * Usage:
 * ```typescript
 * const checker = new HealthChecker({
 *   onWarning: (result) => logger.warn('Health warning', result),
 *   onCritical: (result) => {
 *     logger.error('Health critical!', result);
 *     pauseOperations();
 *   }
 * });
 *
 * // Run a single check
 * const result = await checker.check();
 *
 * // Or start periodic checks
 * const stop = checker.startPeriodic();
 * // ... later
 * stop();
 * ```
 */
export class HealthChecker {
  private readonly options: Required<Omit<HealthCheckOptions, "onWarning" | "onCritical">>;
  private readonly onWarning: HealthCheckOptions["onWarning"];
  private readonly onCritical: HealthCheckOptions["onCritical"];
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private lastStatus: HealthCheckResult | null = null;
  private aiProvider: AIProvider | undefined;
  private worktreeLimit: number | undefined;
  private getWorktreeCount: (() => number) | undefined;

  constructor(options: HealthCheckOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.onWarning = options.onWarning;
    this.onCritical = options.onCritical;
  }

  /**
   * Set an AI provider to check availability
   */
  setAIProvider(provider: AIProvider): void {
    this.aiProvider = provider;
  }

  /**
   * Set worktree monitoring
   */
  setWorktreeMonitoring(limit: number, getCount: () => number): void {
    this.worktreeLimit = limit;
    this.getWorktreeCount = getCount;
  }

  /**
   * Run a single health check
   */
  async check(): Promise<HealthCheckResult> {
    const diskSpace = this.checkDiskSpace();
    const memory = this.checkMemory();

    let aiProvider: AIProviderCheck | undefined;
    if (this.aiProvider) {
      aiProvider = await this.checkAIProvider();
    }

    let worktrees: WorktreeCheck | undefined;
    if (this.worktreeLimit !== undefined && this.getWorktreeCount) {
      worktrees = this.checkWorktrees();
    }

    // Determine overall status (worst of all checks)
    const statuses = [
      diskSpace.status,
      memory.status,
      aiProvider?.status,
      worktrees?.status,
    ].filter((s): s is HealthStatus => s !== undefined);

    let overallStatus: HealthStatus = "ok";
    if (statuses.includes("critical") || statuses.includes("unavailable")) {
      overallStatus = "critical";
    } else if (statuses.includes("warning")) {
      overallStatus = "warning";
    }

    const result: HealthCheckResult = {
      healthy: overallStatus === "ok",
      overallStatus,
      checks: {
        diskSpace,
        memory,
        aiProvider,
        worktrees,
      },
      timestamp: new Date(),
    };

    // Track status changes and invoke callbacks
    const previousStatus = this.lastStatus?.overallStatus;
    this.lastStatus = result;

    if (overallStatus === "critical" && previousStatus !== "critical") {
      this.onCritical?.(result);
    } else if (
      overallStatus === "warning" &&
      previousStatus !== "warning" &&
      previousStatus !== "critical"
    ) {
      this.onWarning?.(result);
    }

    return result;
  }

  /**
   * Start periodic health checks
   *
   * @returns A function to stop the periodic checks
   */
  startPeriodic(): () => void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    // Run initial check
    void this.check().catch((err) => {
      logger.warn("Health check failed", { error: err });
    });

    // Schedule periodic checks
    this.intervalId = setInterval(() => {
      void this.check().catch((err) => {
        logger.warn("Health check failed", { error: err });
      });
    }, this.options.intervalMs);

    logger.debug(`Started periodic health checks every ${this.options.intervalMs}ms`);

    return () => this.stopPeriodic();
  }

  /**
   * Stop periodic health checks
   */
  stopPeriodic(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      logger.debug("Stopped periodic health checks");
    }
  }

  /**
   * Get the last health check result
   */
  getLastStatus(): HealthCheckResult | null {
    return this.lastStatus;
  }

  /**
   * Check disk space
   */
  checkDiskSpace(): DiskSpaceCheck {
    try {
      const stats = statfsSync(this.options.diskPath);
      const blockSize = stats.bsize;
      const availableBytes = stats.bavail * blockSize;
      const totalBytes = stats.blocks * blockSize;
      const usedBytes = totalBytes - availableBytes;

      const availableGb = availableBytes / (1024 * 1024 * 1024);
      const usedPercent = (usedBytes / totalBytes) * 100;

      let status: HealthStatus = "ok";
      if (availableGb < this.options.diskCriticalThresholdGb) {
        status = "critical";
      } else if (availableGb < this.options.diskWarningThresholdGb) {
        status = "warning";
      }

      return {
        status,
        availableGb: Math.round(availableGb * 100) / 100,
        usedPercent: Math.round(usedPercent * 10) / 10,
        path: this.options.diskPath,
      };
    } catch (error) {
      logger.warn("Failed to check disk space", { error });
      return {
        status: "unavailable",
        availableGb: 0,
        usedPercent: 0,
        path: this.options.diskPath,
      };
    }
  }

  /**
   * Check memory usage
   */
  checkMemory(): MemoryCheck {
    const totalMb = totalmem() / (1024 * 1024);
    const freeMb = freemem() / (1024 * 1024);
    const usedMb = totalMb - freeMb;
    const usedPercent = (usedMb / totalMb) * 100;

    let status: HealthStatus = "ok";
    if (freeMb < this.options.memoryWarningThresholdMb) {
      // Memory is quite low
      status = "warning";
    }

    return {
      status,
      usedMb: Math.round(usedMb),
      availableMb: Math.round(freeMb),
      usedPercent: Math.round(usedPercent * 10) / 10,
    };
  }

  /**
   * Check AI provider availability
   */
  private async checkAIProvider(): Promise<AIProviderCheck> {
    if (!this.aiProvider) {
      return {
        status: "unavailable",
        lastCheck: new Date(),
        error: "No AI provider configured",
      };
    }

    const startTime = Date.now();

    try {
      const available = await this.aiProvider.isAvailable();
      const latencyMs = Date.now() - startTime;

      return {
        status: available ? "ok" : "unavailable",
        lastCheck: new Date(),
        latencyMs,
      };
    } catch (error) {
      return {
        status: "unavailable",
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check worktree count
   */
  private checkWorktrees(): WorktreeCheck {
    if (this.worktreeLimit === undefined || !this.getWorktreeCount) {
      return {
        count: 0,
        limit: 0,
        status: "unavailable",
      };
    }

    const count = this.getWorktreeCount();
    const limit = this.worktreeLimit;

    let status: HealthStatus = "ok";
    if (count >= limit) {
      status = "critical";
    } else if (count >= limit * 0.8) {
      status = "warning";
    }

    return {
      count,
      limit,
      status,
    };
  }
}

/**
 * Create a pre-configured health checker for autonomous operations
 */
export function createAutonomousHealthChecker(options: {
  dataDir: string;
  onWarning?: (result: HealthCheckResult) => void;
  onCritical?: (result: HealthCheckResult) => void;
}): HealthChecker {
  return new HealthChecker({
    diskPath: options.dataDir,
    intervalMs: 60000, // Check every minute
    diskWarningThresholdGb: 1.0,
    diskCriticalThresholdGb: 0.5,
    memoryWarningThresholdMb: 100,
    onWarning: options.onWarning,
    onCritical: options.onCritical,
  });
}
