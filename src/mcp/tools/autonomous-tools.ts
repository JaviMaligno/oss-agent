/**
 * MCP Autonomous Tools
 *
 * Implements run_autonomous, work_parallel, cancel_work, parallel_status
 *
 * Note: These tools provide simplified wrappers. The actual autonomous runner
 * and parallel orchestrator have complex dependencies that require full
 * initialization. For MCP usage, these tools return "not implemented" for
 * the complex operations and work correctly for status/cancel operations.
 */

import type { Config } from "../../types/config.js";
import type { StateManager } from "../../core/state/state-manager.js";
import type { MCPContext, ToolResult } from "../types.js";
import type { RegisteredTool, ToolHandler } from "./index.js";
import { logger } from "../../infra/logger.js";

export interface AutonomousToolsOptions {
  config: Config;
  stateManager: StateManager;
}

/**
 * Create autonomous tool handlers
 */
export function createAutonomousTools(options: AutonomousToolsOptions): RegisteredTool[] {
  const { config, stateManager } = options;

  return [
    createRunAutonomousTool(config, stateManager),
    createWorkParallelTool(config, stateManager),
    createCancelWorkTool(stateManager),
    createParallelStatusTool(stateManager),
  ];
}

/**
 * run_autonomous - Run autonomous mode to process issues from queue
 *
 * Note: This is a complex operation that requires CLI execution.
 * Use the CLI command `oss-agent run` for full autonomous mode.
 */
function createRunAutonomousTool(_config: Config, stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const dryRun = args["dryRun"] as boolean | undefined;

    try {
      if (dryRun) {
        // In dry run mode, show what would be processed
        const queuedIssues = stateManager.getIssuesByState("queued");

        return {
          success: true,
          data: {
            dryRun: true,
            message: "Dry run - showing queue status",
            queueSize: queuedIssues.length,
            wouldProcess: queuedIssues.slice(0, 10).map((i) => ({
              id: i.id,
              url: i.url,
              title: i.title,
            })),
          },
        };
      }

      // Full autonomous mode requires CLI execution
      return {
        success: false,
        error: {
          code: "NOT_SUPPORTED",
          message:
            "Autonomous mode via MCP is not fully supported due to complex dependencies. " +
            "Use 'oss-agent run' CLI command for full autonomous mode, or use dryRun=true " +
            "to preview what would be processed.",
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`run_autonomous failed: ${message}`);
      return {
        success: false,
        error: {
          code: "AUTONOMOUS_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "run_autonomous",
      description:
        "Run autonomous mode to process issues from the queue. Use dryRun=true to preview.",
      inputSchema: {
        type: "object",
        properties: {
          maxIterations: {
            type: "number",
            description: "Maximum issues to process",
          },
          maxDurationHours: {
            type: "number",
            description: "Maximum run duration in hours",
          },
          maxBudgetUsd: {
            type: "number",
            description: "Maximum budget for the run",
          },
          cooldownMs: {
            type: "number",
            description: "Delay between issues in milliseconds",
          },
          autoReplenish: {
            type: "boolean",
            description: "Auto-replenish queue when low",
          },
          dryRun: {
            type: "boolean",
            description: "Preview mode - show what would be processed without executing",
          },
        },
      },
    },
    handler,
  };
}

/**
 * work_parallel - Work on multiple issues in parallel
 *
 * Note: This is a complex operation that requires CLI execution.
 * Use the CLI command `oss-agent work-parallel` for full parallel mode.
 */
function createWorkParallelTool(_config: Config, stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const count = args["count"] as number | undefined;
    const issueUrls = args["issueUrls"] as string[] | undefined;

    try {
      // Show what would be processed
      let urlsToProcess = issueUrls ?? [];
      if (count && urlsToProcess.length === 0) {
        const queuedIssues = stateManager.getIssuesByState("queued");
        urlsToProcess = queuedIssues.slice(0, count).map((i) => i.url);
      }

      if (urlsToProcess.length === 0) {
        return {
          success: false,
          error: {
            code: "EMPTY_QUEUE",
            message: "No issues to process",
          },
        };
      }

      // Full parallel mode requires CLI execution
      return {
        success: false,
        error: {
          code: "NOT_SUPPORTED",
          message:
            "Parallel work via MCP is not fully supported due to complex dependencies. " +
            "Use 'oss-agent work-parallel' CLI command for full parallel mode.",
          details: {
            wouldProcess: urlsToProcess,
            count: urlsToProcess.length,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`work_parallel failed: ${message}`);
      return {
        success: false,
        error: {
          code: "PARALLEL_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "work_parallel",
      description: "Work on multiple issues in parallel",
      inputSchema: {
        type: "object",
        properties: {
          count: {
            type: "number",
            description: "Number of issues to work on in parallel (from queue)",
          },
          issueUrls: {
            type: "array",
            items: { type: "string" },
            description: "Specific issue URLs to process",
          },
          maxBudgetUsd: {
            type: "number",
            description: "Maximum budget for all issues",
          },
          skipPR: {
            type: "boolean",
            description: "Skip creating pull requests",
          },
        },
      },
    },
    handler,
  };
}

/**
 * cancel_work - Cancel work on a specific issue
 */
function createCancelWorkTool(stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const issueId = args["issueId"] as string | undefined;
    const issueUrl = args["issueUrl"] as string | undefined;

    try {
      const targetIssue = issueId ?? issueUrl;
      if (!targetIssue) {
        return {
          success: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: "Either issueId or issueUrl is required",
          },
        };
      }

      // Find issue
      let issue = issueId ? stateManager.getIssue(issueId) : null;
      if (!issue && issueUrl) {
        issue = stateManager.getIssueByUrl(issueUrl);
      }

      if (!issue) {
        return {
          success: false,
          error: {
            code: "NOT_FOUND",
            message: `Issue not found: ${targetIssue}`,
          },
        };
      }

      // Only can cancel in_progress issues
      if (issue.state !== "in_progress") {
        return {
          success: false,
          error: {
            code: "INVALID_STATE",
            message: `Cannot cancel issue in state '${issue.state}'. Only in_progress issues can be cancelled.`,
          },
        };
      }

      // Transition to abandoned
      stateManager.transitionIssue(issue.id, "abandoned", "Cancelled via MCP");
      logger.info(`Cancelled work on issue: ${issue.url}`);

      return {
        success: true,
        data: {
          message: `Cancelled work on issue`,
          issueId: issue.id,
          issueUrl: issue.url,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`cancel_work failed: ${message}`);
      return {
        success: false,
        error: {
          code: "CANCEL_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "cancel_work",
      description: "Cancel work on a specific issue",
      inputSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "Issue ID to cancel",
          },
          issueUrl: {
            type: "string",
            description: "Issue URL to cancel",
          },
        },
      },
    },
    handler,
  };
}

/**
 * parallel_status - Show status of parallel work operations
 */
function createParallelStatusTool(stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (_args, _context: MCPContext): Promise<ToolResult> => {
    try {
      // Get issues by state to show current work status
      const queuedIssues = stateManager.getIssuesByState("queued");
      const inProgressIssues = stateManager.getIssuesByState("in_progress");
      const prCreatedIssues = stateManager.getIssuesByState("pr_created");
      const awaitingFeedbackIssues = stateManager.getIssuesByState("awaiting_feedback");
      const completedIssues = stateManager.getIssuesByState("merged");
      const abandonedIssues = stateManager.getIssuesByState("abandoned");

      return {
        success: true,
        data: {
          summary: {
            queued: queuedIssues.length,
            inProgress: inProgressIssues.length,
            prCreated: prCreatedIssues.length,
            awaitingFeedback: awaitingFeedbackIssues.length,
            completed: completedIssues.length,
            abandoned: abandonedIssues.length,
          },
          inProgress: inProgressIssues.map((i) => ({
            id: i.id,
            url: i.url,
            title: i.title,
            projectId: i.projectId,
          })),
          recentlyCompleted: completedIssues.slice(0, 5).map((i) => ({
            id: i.id,
            url: i.url,
            title: i.title,
            prUrl: i.linkedPRUrl,
          })),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`parallel_status failed: ${message}`);
      return {
        success: false,
        error: {
          code: "STATUS_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "parallel_status",
      description: "Show status of parallel work operations",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler,
  };
}
