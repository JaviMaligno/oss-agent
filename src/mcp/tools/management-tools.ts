/**
 * MCP Management Tools
 *
 * Implements get_config, update_config, cleanup_worktrees
 */

import type { Config } from "../../types/config.js";
import type { StateManager } from "../../core/state/state-manager.js";
import type { MCPContext, ToolResult } from "../types.js";
import type { RegisteredTool, ToolHandler } from "./index.js";
import { expandPath } from "../../cli/config/loader.js";
import { logger } from "../../infra/logger.js";
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, basename } from "node:path";

export interface ManagementToolsOptions {
  config: Config;
  stateManager: StateManager;
}

/**
 * Create management tool handlers
 */
export function createManagementTools(options: ManagementToolsOptions): RegisteredTool[] {
  const { config, stateManager } = options;

  return [
    createGetConfigTool(config),
    createUpdateConfigTool(),
    createCleanupWorktreesTool(config, stateManager),
  ];
}

/**
 * get_config - Get current configuration
 */
function createGetConfigTool(config: Config): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const key = args["key"] as string | undefined;

    try {
      if (key) {
        // Get specific config key using dot notation
        const value = getNestedValue(config, key);
        if (value === undefined) {
          return {
            success: false,
            error: {
              code: "NOT_FOUND",
              message: `Config key not found: ${key}`,
            },
          };
        }

        return {
          success: true,
          data: {
            key,
            value,
          },
        };
      }

      // Return safe subset of config (exclude sensitive data)
      const safeConfig = {
        dataDir: config.dataDir,
        ai: {
          executionMode: config.ai.executionMode,
          model: config.ai.model,
          provider: config.ai.provider,
          cli: {
            path: config.ai.cli.path,
            autoApprove: config.ai.cli.autoApprove,
            maxTurns: config.ai.cli.maxTurns,
          },
        },
        git: {
          defaultBranch: config.git.defaultBranch,
          branchPrefix: config.git.branchPrefix,
          commitSignoff: config.git.commitSignoff,
          existingBranchStrategy: config.git.existingBranchStrategy,
        },
        budget: {
          dailyLimitUsd: config.budget.dailyLimitUsd,
          monthlyLimitUsd: config.budget.monthlyLimitUsd,
          perIssueLimitUsd: config.budget.perIssueLimitUsd,
        },
        parallel: {
          maxConcurrentAgents: config.parallel.maxConcurrentAgents,
          enableConflictDetection: config.parallel.enableConflictDetection,
        },
        oss: config.oss
          ? {
              discoveryMode: config.oss.discoveryMode,
              qualityGates: config.oss.qualityGates,
            }
          : undefined,
        mcp: config.mcp,
      };

      return {
        success: true,
        data: {
          config: safeConfig,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`get_config failed: ${message}`);
      return {
        success: false,
        error: {
          code: "CONFIG_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "get_config",
      description: "Get current configuration",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Specific config key (dot notation, e.g., 'budget.dailyLimitUsd')",
          },
        },
      },
    },
    handler,
  };
}

/**
 * update_config - Update configuration value
 * Note: This is a read-only tool that shows what would be updated.
 * Actual config changes should be made via the CLI config command or editing config.json.
 */
function createUpdateConfigTool(): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const key = args["key"] as string;
    const value = args["value"];

    if (!key) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "key is required",
        },
      };
    }

    if (value === undefined) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "value is required",
        },
      };
    }

    // For security reasons, we don't allow runtime config changes via MCP
    // Return information about how to update the config instead
    return {
      success: false,
      error: {
        code: "NOT_SUPPORTED",
        message:
          "Runtime config updates via MCP are not supported for security reasons. " +
          "Use 'oss-agent config set' CLI command or edit ~/.oss-agent/config.json directly.",
      },
    };
  };

  return {
    definition: {
      name: "update_config",
      description: "Update configuration value (returns instructions, does not modify config)",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Config key to update (dot notation)",
          },
          value: {
            description: "New value",
          },
        },
        required: ["key", "value"],
      },
    },
    handler,
  };
}

/**
 * cleanup_worktrees - Clean up old git worktrees
 */
function createCleanupWorktreesTool(config: Config, stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const olderThanHours = args["olderThanHours"] as number | undefined;
    const projectId = args["projectId"] as string | undefined;
    const force = args["force"] as boolean | undefined;

    try {
      const dataDir = expandPath(config.dataDir);
      const worktreesDir = join(dataDir, "worktrees");

      // Check if worktrees directory exists
      if (!existsSync(worktreesDir)) {
        return {
          success: true,
          data: {
            message: "No worktrees directory found",
            totalWorktrees: 0,
            cleaned: 0,
          },
        };
      }

      // List worktree directories
      const entries = readdirSync(worktreesDir, { withFileTypes: true });
      const worktreeDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({
          name: e.name,
          path: join(worktreesDir, e.name),
          createdAt: statSync(join(worktreesDir, e.name)).mtime,
        }));

      // Filter by age
      const now = Date.now();
      const maxAgeMs = olderThanHours ? olderThanHours * 60 * 60 * 1000 : 24 * 60 * 60 * 1000; // Default 24 hours

      const worktreesToClean = worktreeDirs.filter((wt) => {
        // Filter by project if specified
        if (projectId && !wt.name.includes(projectId.replace("/", "-"))) {
          return false;
        }

        // Filter by age
        const age = now - wt.createdAt.getTime();
        return age > maxAgeMs;
      });

      if (worktreesToClean.length === 0) {
        return {
          success: true,
          data: {
            message: "No worktrees to clean up",
            totalWorktrees: worktreeDirs.length,
            cleaned: 0,
          },
        };
      }

      // Check if any worktrees are in use (have in_progress issues)
      const inProgressIssues = stateManager.getIssuesByState("in_progress");
      const inUseProjectIds = new Set(inProgressIssues.map((i) => i.projectId.replace("/", "-")));

      const cleaned: string[] = [];
      const skipped: string[] = [];

      for (const wt of worktreesToClean) {
        // Check if worktree is in use
        const isInUse = Array.from(inUseProjectIds).some((pid) => wt.name.includes(pid));

        if (isInUse && !force) {
          skipped.push(wt.path);
          logger.warn(`Skipping in-use worktree: ${wt.path}`);
          continue;
        }

        try {
          // Remove the worktree directory
          rmSync(wt.path, { recursive: true, force: true });
          cleaned.push(wt.path);
          logger.info(`Cleaned up worktree: ${wt.path}`);
        } catch (error) {
          logger.warn(`Failed to clean worktree ${wt.path}: ${error}`);
          skipped.push(wt.path);
        }
      }

      return {
        success: true,
        data: {
          message: `Cleaned ${cleaned.length} worktree(s)`,
          totalWorktrees: worktreeDirs.length,
          cleaned: cleaned.length,
          skipped: skipped.length,
          cleanedPaths: cleaned.map((p) => basename(p)),
          skippedPaths: skipped.map((p) => basename(p)),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`cleanup_worktrees failed: ${message}`);
      return {
        success: false,
        error: {
          code: "CLEANUP_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "cleanup_worktrees",
      description: "Clean up old git worktrees",
      inputSchema: {
        type: "object",
        properties: {
          olderThanHours: {
            type: "number",
            description: "Only cleanup worktrees older than N hours (default: 24)",
          },
          projectId: {
            type: "string",
            description: "Only cleanup worktrees for specific project (owner/repo)",
          },
          force: {
            type: "boolean",
            description: "Force cleanup even if worktree may be in use",
          },
        },
      },
    },
    handler,
  };
}

/**
 * Helper to get nested value from object using dot notation
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}
