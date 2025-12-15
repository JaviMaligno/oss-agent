/**
 * MCP Queue Tools
 *
 * Implements queue_list, queue_add, queue_remove, queue_prioritize, queue_clear
 */

import type { Config } from "../../types/config.js";
import type { StateManager } from "../../core/state/state-manager.js";
import type { MCPContext, ToolResult } from "../types.js";
import type { RegisteredTool, ToolHandler } from "./index.js";
import type { Issue } from "../../types/issue.js";
import { logger } from "../../infra/logger.js";

export interface QueueToolsOptions {
  config: Config;
  stateManager: StateManager;
}

/**
 * Create queue tool handlers
 */
export function createQueueTools(options: QueueToolsOptions): RegisteredTool[] {
  const { config, stateManager } = options;

  return [
    createQueueListTool(stateManager),
    createQueueAddTool(config, stateManager),
    createQueueRemoveTool(stateManager),
    createQueuePrioritizeTool(stateManager),
    createQueueClearTool(stateManager),
  ];
}

/**
 * queue_list - List all issues in the work queue
 */
function createQueueListTool(stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (_args, _context: MCPContext): Promise<ToolResult> => {
    try {
      const queuedIssues = stateManager.getIssuesByState("queued");

      return {
        success: true,
        data: {
          count: queuedIssues.length,
          issues: queuedIssues.map((issue) => ({
            id: issue.id,
            url: issue.url,
            number: issue.number,
            title: issue.title,
            projectId: issue.projectId,
            labels: issue.labels,
            author: issue.author,
            createdAt: issue.createdAt.toISOString(),
            updatedAt: issue.updatedAt.toISOString(),
          })),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`queue_list failed: ${message}`);
      return {
        success: false,
        error: {
          code: "QUEUE_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "queue_list",
      description: "List all issues in the work queue",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler,
  };
}

/**
 * queue_add - Add an issue to the work queue
 */
function createQueueAddTool(_config: Config, stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const issueUrl = args["issueUrl"] as string;
    // Note: priority parameter is accepted but not yet used for ordering
    // Future: implement priority-based queue ordering

    if (!issueUrl) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "issueUrl is required",
        },
      };
    }

    // Validate URL format
    if (!issueUrl.match(/github\.com\/[^/]+\/[^/]+\/issues\/\d+/)) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Invalid GitHub issue URL format",
        },
      };
    }

    try {
      // Check if issue already exists
      const existing = stateManager.getIssueByUrl(issueUrl);
      if (existing) {
        if (existing.state === "queued") {
          return {
            success: true,
            data: {
              message: "Issue already in queue",
              issueId: existing.id,
              state: existing.state,
            },
          };
        }
        return {
          success: false,
          error: {
            code: "ALREADY_EXISTS",
            message: `Issue already exists in state '${existing.state}'`,
          },
        };
      }

      // Parse URL to extract info
      const match = issueUrl.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
      if (!match) {
        return {
          success: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: "Could not parse issue URL",
          },
        };
      }

      const [, owner, repo, numberStr] = match;
      const issueNumber = parseInt(numberStr!, 10);
      const projectId = `${owner}/${repo}`;

      // Create issue record in queued state
      const issue: Issue = {
        id: `${projectId}#${issueNumber}`,
        url: issueUrl,
        number: issueNumber,
        title: `Issue #${issueNumber}`, // Will be updated when processed
        body: "",
        labels: [],
        state: "queued",
        author: "",
        assignee: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        projectId,
        hasLinkedPR: false,
        linkedPRUrl: null,
      };

      stateManager.saveIssue(issue);
      logger.info(`Added issue to queue: ${issueUrl}`);

      return {
        success: true,
        data: {
          message: "Issue added to queue",
          issueId: issue.id,
          issueUrl: issue.url,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`queue_add failed: ${message}`);
      return {
        success: false,
        error: {
          code: "QUEUE_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "queue_add",
      description: "Add an issue to the work queue",
      inputSchema: {
        type: "object",
        properties: {
          issueUrl: {
            type: "string",
            description: "GitHub issue URL to add",
          },
          priority: {
            type: "number",
            description: "Priority (higher = more important)",
          },
        },
        required: ["issueUrl"],
      },
    },
    handler,
  };
}

/**
 * queue_remove - Remove an issue from the work queue
 */
function createQueueRemoveTool(stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const issueId = args["issueId"] as string | undefined;
    const issueUrl = args["issueUrl"] as string | undefined;

    if (!issueId && !issueUrl) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Either issueId or issueUrl is required",
        },
      };
    }

    try {
      let issue: Issue | null = null;

      if (issueId) {
        issue = stateManager.getIssue(issueId);
      } else if (issueUrl) {
        issue = stateManager.getIssueByUrl(issueUrl);
      }

      if (!issue) {
        return {
          success: false,
          error: {
            code: "NOT_FOUND",
            message: `Issue not found: ${issueId ?? issueUrl}`,
          },
        };
      }

      if (issue.state !== "queued") {
        return {
          success: false,
          error: {
            code: "INVALID_STATE",
            message: `Issue is not in queue (state: ${issue.state})`,
          },
        };
      }

      // Transition to abandoned
      stateManager.transitionIssue(issue.id, "abandoned", "Removed from queue via MCP");
      logger.info(`Removed issue from queue: ${issue.url}`);

      return {
        success: true,
        data: {
          message: "Issue removed from queue",
          issueId: issue.id,
          issueUrl: issue.url,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`queue_remove failed: ${message}`);
      return {
        success: false,
        error: {
          code: "QUEUE_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "queue_remove",
      description: "Remove an issue from the work queue",
      inputSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "Issue ID to remove",
          },
          issueUrl: {
            type: "string",
            description: "Issue URL to remove (alternative to issueId)",
          },
        },
      },
    },
    handler,
  };
}

/**
 * queue_prioritize - Change the priority of a queued issue
 */
function createQueuePrioritizeTool(stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const issueId = args["issueId"] as string | undefined;
    const issueUrl = args["issueUrl"] as string | undefined;
    // Note: priority parameter is accepted but not yet used for explicit ordering
    // Current implementation uses timestamp-based priority

    if (!issueId && !issueUrl) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Either issueId or issueUrl is required",
        },
      };
    }

    try {
      let issue: Issue | null = null;

      if (issueId) {
        issue = stateManager.getIssue(issueId);
      } else if (issueUrl) {
        issue = stateManager.getIssueByUrl(issueUrl);
      }

      if (!issue) {
        return {
          success: false,
          error: {
            code: "NOT_FOUND",
            message: `Issue not found: ${issueId ?? issueUrl}`,
          },
        };
      }

      if (issue.state !== "queued") {
        return {
          success: false,
          error: {
            code: "INVALID_STATE",
            message: `Issue is not in queue (state: ${issue.state})`,
          },
        };
      }

      // Update the issue's timestamp to bump priority
      // (Issues are processed in order, so updating timestamp moves it)
      issue.updatedAt = new Date();
      stateManager.saveIssue(issue);
      logger.info(`Prioritized issue: ${issue.url}`);

      return {
        success: true,
        data: {
          message: "Issue prioritized",
          issueId: issue.id,
          issueUrl: issue.url,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`queue_prioritize failed: ${message}`);
      return {
        success: false,
        error: {
          code: "QUEUE_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "queue_prioritize",
      description: "Change the priority of a queued issue",
      inputSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "Issue ID to prioritize",
          },
          issueUrl: {
            type: "string",
            description: "Issue URL to prioritize (alternative to issueId)",
          },
          priority: {
            type: "number",
            description: "New priority value (higher = more important)",
          },
        },
      },
    },
    handler,
  };
}

/**
 * queue_clear - Clear all issues from the work queue
 */
function createQueueClearTool(stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const confirm = args["confirm"] as boolean | undefined;

    if (!confirm) {
      return {
        success: false,
        error: {
          code: "CONFIRMATION_REQUIRED",
          message: "Set confirm=true to clear the queue",
        },
      };
    }

    try {
      const queuedIssues = stateManager.getIssuesByState("queued");
      const count = queuedIssues.length;

      for (const issue of queuedIssues) {
        stateManager.transitionIssue(issue.id, "abandoned", "Queue cleared via MCP");
      }

      logger.info(`Cleared ${count} issues from queue`);

      return {
        success: true,
        data: {
          message: `Cleared ${count} issue(s) from queue`,
          clearedCount: count,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`queue_clear failed: ${message}`);
      return {
        success: false,
        error: {
          code: "QUEUE_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "queue_clear",
      description: "Clear all issues from the work queue",
      inputSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            description: "Confirm clearing the queue (must be true)",
          },
        },
      },
    },
    handler,
  };
}
