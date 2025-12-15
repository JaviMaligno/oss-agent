/**
 * MCP Monitoring Tools
 *
 * Implements get_pr_status, get_session_history, get_status
 */

import type { Config } from "../../types/config.js";
import type { StateManager } from "../../core/state/state-manager.js";
import type { MCPContext, ToolResult } from "../types.js";
import type { RegisteredTool, ToolHandler } from "./index.js";
import { PRService } from "../../core/github/pr-service.js";
import { FeedbackParser } from "../../core/github/feedback-parser.js";
import { BudgetManager } from "../../core/engine/budget-manager.js";
import { logger } from "../../infra/logger.js";

export interface MonitoringToolsOptions {
  config: Config;
  stateManager: StateManager;
}

/**
 * Create monitoring tool handlers
 */
export function createMonitoringTools(options: MonitoringToolsOptions): RegisteredTool[] {
  const { config, stateManager } = options;

  return [
    createGetPRStatusTool(stateManager),
    createGetSessionHistoryTool(stateManager),
    createGetStatusTool(config, stateManager),
  ];
}

/**
 * get_pr_status - Get PR status including reviews, checks, and feedback
 */
function createGetPRStatusTool(stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const prUrl = args["prUrl"] as string | undefined;

    try {
      const prService = new PRService();
      const feedbackParser = new FeedbackParser();

      // If no URL provided, list all monitored PRs
      if (!prUrl) {
        const prCreatedIssues = stateManager.getIssuesByState("pr_created");
        const awaitingFeedbackIssues = stateManager.getIssuesByState("awaiting_feedback");

        const allPRIssues = [...prCreatedIssues, ...awaitingFeedbackIssues].filter(
          (issue) => issue.linkedPRUrl
        );

        return {
          success: true,
          data: {
            count: allPRIssues.length,
            prs: allPRIssues.map((issue) => ({
              issueId: issue.id,
              issueUrl: issue.url,
              prUrl: issue.linkedPRUrl,
              state: issue.state,
            })),
          },
        };
      }

      // Validate URL format
      if (!prUrl.match(/github\.com\/[^/]+\/[^/]+\/pull\/\d+/)) {
        return {
          success: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: "Invalid GitHub PR URL format",
          },
        };
      }

      // Get detailed PR status
      const parsed = prService.parsePRUrl(prUrl);
      if (!parsed) {
        return {
          success: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: "Could not parse PR URL",
          },
        };
      }

      const { owner, repo, prNumber } = parsed;
      const { pr, reviews, comments, checks } = await prService.getPRFeedback(
        owner,
        repo,
        prNumber
      );

      const feedback = feedbackParser.parse(pr, reviews, comments, checks);
      const unaddressedItems = feedback.actionableItems.filter((item) => !item.addressed);

      return {
        success: true,
        data: {
          pr: {
            url: prUrl,
            title: pr.title,
            state: pr.state,
            checksPass: pr.checksPass,
            mergeable: pr.mergeable,
            headSha: pr.headSha,
            baseBranch: pr.baseBranch,
            createdAt: pr.createdAt.toISOString(),
            updatedAt: pr.updatedAt.toISOString(),
          },
          reviews: {
            total: reviews.length,
            approved: reviews.filter((r) => r.state === "approved").length,
            changesRequested: reviews.filter((r) => r.state === "changes_requested").length,
            pending: reviews.filter((r) => r.state === "pending").length,
          },
          feedback: {
            hasActionableFeedback: unaddressedItems.length > 0,
            actionableItemCount: unaddressedItems.length,
            items: unaddressedItems.map((item) => ({
              type: item.type,
              author: item.author,
              description: item.description.substring(0, 500), // Truncate for response size
              filePath: item.filePath,
              lineNumber: item.lineNumber,
            })),
          },
          checks: {
            total: checks.length,
            passing: checks.filter((c) => c.status === "success").length,
            failing: checks.filter((c) => c.status === "failure").length,
            pending: checks.filter((c) => c.status === "pending").length,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`get_pr_status failed: ${message}`);
      return {
        success: false,
        error: {
          code: "PR_STATUS_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "get_pr_status",
      description: "Get PR status including reviews, checks, and feedback",
      inputSchema: {
        type: "object",
        properties: {
          prUrl: {
            type: "string",
            description: "PR URL (omit to list all monitored PRs)",
          },
        },
      },
    },
    handler,
  };
}

/**
 * get_session_history - Get history of work sessions
 */
function createGetSessionHistoryTool(stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const limit = (args["limit"] as number) ?? 20;
    const issueId = args["issueId"] as string | undefined;

    try {
      // Get session from state manager
      if (issueId) {
        const session = stateManager.getSession(issueId);
        if (!session) {
          return {
            success: false,
            error: {
              code: "NOT_FOUND",
              message: `Session not found for issue: ${issueId}`,
            },
          };
        }

        return {
          success: true,
          data: {
            count: 1,
            sessions: [
              {
                id: session.id,
                issueId: session.issueId,
                issueUrl: session.issueUrl,
                status: session.status,
                startedAt: session.startedAt.toISOString(),
                completedAt: session.completedAt?.toISOString(),
                canResume: session.canResume,
                error: session.error,
              },
            ],
          },
        };
      }

      // List recent issues as session proxies (since getSessions doesn't exist)
      const allIssues = [
        ...stateManager.getIssuesByState("merged"),
        ...stateManager.getIssuesByState("pr_created"),
        ...stateManager.getIssuesByState("awaiting_feedback"),
        ...stateManager.getIssuesByState("in_progress"),
        ...stateManager.getIssuesByState("abandoned"),
      ];

      // Sort by updatedAt descending and limit
      const sortedIssues = allIssues
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit);

      return {
        success: true,
        data: {
          count: sortedIssues.length,
          sessions: sortedIssues.map((issue) => ({
            issueId: issue.id,
            issueUrl: issue.url,
            title: issue.title,
            state: issue.state,
            projectId: issue.projectId,
            hasLinkedPR: issue.hasLinkedPR,
            linkedPRUrl: issue.linkedPRUrl,
            createdAt: issue.createdAt.toISOString(),
            updatedAt: issue.updatedAt.toISOString(),
          })),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`get_session_history failed: ${message}`);
      return {
        success: false,
        error: {
          code: "HISTORY_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "get_session_history",
      description: "Get history of work sessions",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum sessions to return",
          },
          status: {
            type: "string",
            enum: ["active", "completed", "failed", "paused"],
            description: "Filter by status",
          },
          issueId: {
            type: "string",
            description: "Filter by issue ID",
          },
        },
      },
    },
    handler,
  };
}

/**
 * get_status - Get overall system status including budget, queue, and health
 */
function createGetStatusTool(config: Config, stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (_args, _context: MCPContext): Promise<ToolResult> => {
    try {
      const budgetManager = new BudgetManager(stateManager, config.budget);

      // Get budget status
      const budgetCheck = budgetManager.canProceed();
      const budgetStatus = budgetManager.getStatus();

      // Get queue status
      const queuedIssues = stateManager.getIssuesByState("queued");
      const inProgressIssues = stateManager.getIssuesByState("in_progress");
      const prCreatedIssues = stateManager.getIssuesByState("pr_created");
      const awaitingFeedbackIssues = stateManager.getIssuesByState("awaiting_feedback");
      const completedIssues = stateManager.getIssuesByState("merged");

      // Calculate success rate from recent issues
      const totalProcessed = completedIssues.length;
      const abandonedIssues = stateManager.getIssuesByState("abandoned");
      const totalAttempted = totalProcessed + abandonedIssues.length;
      const successRate = totalAttempted > 0 ? totalProcessed / totalAttempted : 0;

      return {
        success: true,
        data: {
          budget: {
            allowed: budgetCheck.allowed,
            reason: budgetCheck.reason,
            usage: {
              today: {
                amount: budgetStatus.todaysCost,
                limit: budgetStatus.dailyLimit,
                percentUsed: budgetStatus.dailyPercentUsed,
                exceeded: budgetStatus.dailyExceeded,
              },
              month: {
                amount: budgetStatus.monthsCost,
                limit: budgetStatus.monthlyLimit,
                percentUsed: budgetStatus.monthlyPercentUsed,
                exceeded: budgetStatus.monthlyExceeded,
              },
              perIssueLimit: config.budget.perIssueLimitUsd,
            },
          },
          queue: {
            queued: queuedIssues.length,
            inProgress: inProgressIssues.length,
            prCreated: prCreatedIssues.length,
            awaitingFeedback: awaitingFeedbackIssues.length,
            completed: completedIssues.length,
          },
          sessions: {
            active: inProgressIssues.length,
            totalProcessed,
            successRate: Math.round(successRate * 100),
          },
          config: {
            aiMode: config.ai.executionMode,
            maxConcurrentAgents: config.parallel.maxConcurrentAgents,
            maxPrsPerDay: config.oss?.qualityGates?.maxPrsPerDay ?? 10,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`get_status failed: ${message}`);
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
      name: "get_status",
      description: "Get overall system status including budget, queue, and health",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler,
  };
}
