/**
 * MCP Workflow Tools
 *
 * Implements work_on_issue, iterate_on_feedback, resume_session, watch_prs
 */

import type { Config } from "../../types/config.js";
import type { StateManager } from "../../core/state/state-manager.js";
import type { MCPContext, ToolResult } from "../types.js";
import type { RegisteredTool, ToolHandler } from "./index.js";
import { IssueProcessor, ProcessIssueResult } from "../../core/engine/issue-processor.js";
import { IterationHandler, IterationOptions } from "../../core/engine/iteration-handler.js";
import { GitOperations } from "../../core/git/git-operations.js";
import { createProvider } from "../../core/ai/provider-factory.js";
import { PRMonitor } from "../../core/github/pr-monitor.js";
import { PRService } from "../../core/github/pr-service.js";
import { FeedbackParser } from "../../core/github/feedback-parser.js";
import { expandPath } from "../../cli/config/loader.js";
import { logger } from "../../infra/logger.js";

/**
 * Helper to create GitOperations with proper config
 */
function createGitOperations(config: Config): GitOperations {
  const dataDir = expandPath(config.dataDir);
  return new GitOperations(config.git, dataDir, config.hardening);
}

export interface WorkflowToolsOptions {
  config: Config;
  stateManager: StateManager;
}

/**
 * Create workflow tool handlers
 */
export function createWorkflowTools(options: WorkflowToolsOptions): RegisteredTool[] {
  const { config, stateManager } = options;

  return [
    createWorkOnIssueTool(config, stateManager),
    createIterateOnFeedbackTool(config, stateManager),
    createResumeSessionTool(config, stateManager),
    createWatchPrsTool(config, stateManager),
  ];
}

/**
 * work_on_issue - Process a GitHub issue end-to-end
 */
function createWorkOnIssueTool(config: Config, stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const issueUrl = args["issueUrl"] as string;
    const maxBudgetUsd = args["maxBudgetUsd"] as number | undefined;
    const skipPR = args["skipPR"] as boolean | undefined;
    const dryRun = args["dryRun"] as boolean | undefined;

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
      // Initialize dependencies
      const gitOps = createGitOperations(config);
      const aiProvider = await createProvider(config);

      const processor = new IssueProcessor(config, stateManager, gitOps, aiProvider);

      if (dryRun) {
        // In dry run mode, just analyze the issue without making changes
        logger.info(`[DRY RUN] Would process issue: ${issueUrl}`);
        return {
          success: true,
          data: {
            dryRun: true,
            issueUrl,
            message: "Dry run - no changes made",
          },
        };
      }

      const processOptions: { issueUrl: string; maxBudgetUsd?: number; skipPR?: boolean } = {
        issueUrl,
      };
      if (maxBudgetUsd !== undefined) {
        processOptions.maxBudgetUsd = maxBudgetUsd;
      }
      if (skipPR !== undefined) {
        processOptions.skipPR = skipPR;
      }

      const result: ProcessIssueResult = await processor.processIssue(processOptions);

      if (result.error) {
        return {
          success: result.success,
          data: {
            issueUrl: result.issue.url,
            issueId: result.issue.id,
            sessionId: result.session.id,
            prUrl: result.prUrl,
            metrics: result.metrics,
            state: result.issue.state,
          },
          error: {
            code: "PROCESSING_ERROR",
            message: result.error,
          },
        };
      }

      return {
        success: result.success,
        data: {
          issueUrl: result.issue.url,
          issueId: result.issue.id,
          sessionId: result.session.id,
          prUrl: result.prUrl,
          metrics: result.metrics,
          state: result.issue.state,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`work_on_issue failed: ${message}`);
      return {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "work_on_issue",
      description: "Work on a GitHub issue end-to-end: analyze, implement, test, and create a PR",
      inputSchema: {
        type: "object",
        properties: {
          issueUrl: {
            type: "string",
            description: "GitHub issue URL to work on",
          },
          maxBudgetUsd: {
            type: "number",
            description: "Maximum budget for this issue in USD",
          },
          skipPR: {
            type: "boolean",
            description: "Skip PR creation (just implement and commit)",
          },
          dryRun: {
            type: "boolean",
            description: "Analyze without making changes",
          },
        },
        required: ["issueUrl"],
      },
    },
    handler,
  };
}

/**
 * iterate_on_feedback - Address PR review feedback
 */
function createIterateOnFeedbackTool(config: Config, stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const prUrl = args["prUrl"] as string;
    const maxBudgetUsd = args["maxBudgetUsd"] as number | undefined;
    const instructions = args["instructions"] as string | undefined;

    if (!prUrl) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "prUrl is required",
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

    try {
      // Initialize dependencies
      const gitOps = createGitOperations(config);
      const aiProvider = await createProvider(config);

      const iterationHandler = new IterationHandler(config, stateManager, gitOps, aiProvider);

      const iterationOptions: IterationOptions = {
        prUrl,
      };
      if (maxBudgetUsd !== undefined) {
        iterationOptions.maxBudgetUsd = maxBudgetUsd;
      }

      // Note: instructions parameter would need to be added to IterationHandler
      // For now, we log it as additional context
      if (instructions) {
        logger.info(`Additional instructions provided: ${instructions}`);
      }

      const result = await iterationHandler.iterate(iterationOptions);

      if (result.error) {
        return {
          success: result.success,
          data: {
            prUrl,
            addressedItems: result.addressedItems,
            failedItems: result.failedItems,
            newCommitSha: result.newCommitSha,
            filesChanged: result.filesChanged,
            metrics: result.metrics,
          },
          error: {
            code: "ITERATION_ERROR",
            message: result.error,
          },
        };
      }

      return {
        success: result.success,
        data: {
          prUrl,
          addressedItems: result.addressedItems,
          failedItems: result.failedItems,
          newCommitSha: result.newCommitSha,
          filesChanged: result.filesChanged,
          metrics: result.metrics,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`iterate_on_feedback failed: ${message}`);
      return {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "iterate_on_feedback",
      description: "Address PR review feedback by making requested changes",
      inputSchema: {
        type: "object",
        properties: {
          prUrl: {
            type: "string",
            description: "GitHub PR URL to iterate on",
          },
          maxBudgetUsd: {
            type: "number",
            description: "Maximum budget for iteration in USD",
          },
          instructions: {
            type: "string",
            description: "Additional instructions for the AI",
          },
        },
        required: ["prUrl"],
      },
    },
    handler,
  };
}

/**
 * resume_session - Resume a previous work session
 */
function createResumeSessionTool(config: Config, stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const sessionId = args["sessionId"] as string;

    if (!sessionId) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "sessionId is required",
        },
      };
    }

    try {
      // Find the session
      const session = stateManager.getSession(sessionId);
      if (!session) {
        return {
          success: false,
          error: {
            code: "NOT_FOUND",
            message: `Session ${sessionId} not found`,
          },
        };
      }

      // Check if session can be resumed
      if (!session.canResume) {
        return {
          success: false,
          error: {
            code: "INVALID_STATE",
            message: `Session ${sessionId} cannot be resumed (status: ${session.status})`,
          },
        };
      }

      // Get the associated issue
      const issue = stateManager.getIssue(session.issueId);
      if (!issue) {
        return {
          success: false,
          error: {
            code: "NOT_FOUND",
            message: `Issue ${session.issueId} not found`,
          },
        };
      }

      // Initialize dependencies and process
      const gitOps = createGitOperations(config);
      const aiProvider = await createProvider(config);

      const processor = new IssueProcessor(config, stateManager, gitOps, aiProvider);

      const result = await processor.processIssue({
        issueUrl: session.issueUrl,
        resume: true,
      });

      if (result.error) {
        return {
          success: result.success,
          data: {
            sessionId,
            issueUrl: result.issue.url,
            prUrl: result.prUrl,
            metrics: result.metrics,
            state: result.issue.state,
          },
          error: {
            code: "RESUME_ERROR",
            message: result.error,
          },
        };
      }

      return {
        success: result.success,
        data: {
          sessionId,
          issueUrl: result.issue.url,
          prUrl: result.prUrl,
          metrics: result.metrics,
          state: result.issue.state,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`resume_session failed: ${message}`);
      return {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "resume_session",
      description: "Resume a previous work session",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "Session ID to resume",
          },
        },
        required: ["sessionId"],
      },
    },
    handler,
  };
}

/**
 * watch_prs - Monitor PRs for feedback and optionally auto-iterate
 */
function createWatchPrsTool(config: Config, stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const intervalMinutes = (args["intervalMinutes"] as number) ?? 5;
    const maxIterations = (args["maxIterations"] as number) ?? 3;
    const autoIterate = (args["autoIterate"] as boolean) ?? false;

    try {
      // Get all PRs that need monitoring
      const prCreatedIssues = stateManager.getIssuesByState("pr_created");
      const awaitingFeedbackIssues = stateManager.getIssuesByState("awaiting_feedback");

      const monitoredPRs = [...prCreatedIssues, ...awaitingFeedbackIssues]
        .filter((issue) => issue.linkedPRUrl)
        .map((issue) => ({
          issueId: issue.id,
          prUrl: issue.linkedPRUrl!,
          state: issue.state,
        }));

      if (monitoredPRs.length === 0) {
        return {
          success: true,
          data: {
            message: "No PRs to monitor",
            monitored: [],
          },
        };
      }

      // Check feedback status for each PR
      const prService = new PRService();
      const feedbackParser = new FeedbackParser();
      const prMonitor = new PRMonitor(prService, feedbackParser);
      const statusResults: Array<{
        prUrl: string;
        hasActionableFeedback: boolean;
        feedbackCount: number;
        needsIteration: boolean;
      }> = [];

      for (const pr of monitoredPRs) {
        try {
          const feedbackStatus = await prMonitor.checkOnce(pr.prUrl);
          // Check if there are unaddressed actionable items
          const unaddressedItems = feedbackStatus.actionableItems.filter((item) => !item.addressed);
          const hasActionableFeedback = unaddressedItems.length > 0;

          statusResults.push({
            prUrl: pr.prUrl,
            hasActionableFeedback,
            feedbackCount: unaddressedItems.length,
            needsIteration: hasActionableFeedback && autoIterate,
          });

          // If auto-iterate is enabled and there's feedback, trigger iteration
          if (autoIterate && hasActionableFeedback) {
            const gitOps = createGitOperations(config);
            const aiProvider = await createProvider(config);
            const iterationHandler = new IterationHandler(config, stateManager, gitOps, aiProvider);

            const iterationResult = await iterationHandler.iterate({
              prUrl: pr.prUrl,
              maxBudgetUsd: config.budget.perIssueLimitUsd,
            });

            logger.info(
              `Auto-iteration for ${pr.prUrl}: ${iterationResult.success ? "success" : "failed"}`
            );
          }
        } catch (error) {
          logger.warn(`Failed to check PR ${pr.prUrl}: ${error}`);
        }
      }

      return {
        success: true,
        data: {
          intervalMinutes,
          maxIterations,
          autoIterate,
          monitored: statusResults,
          message: `Monitoring ${statusResults.length} PR(s)`,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`watch_prs failed: ${message}`);
      return {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "watch_prs",
      description: "Monitor PRs for feedback and automatically iterate",
      inputSchema: {
        type: "object",
        properties: {
          intervalMinutes: {
            type: "number",
            description: "Polling interval in minutes",
          },
          maxIterations: {
            type: "number",
            description: "Maximum iterations per PR",
          },
          autoIterate: {
            type: "boolean",
            description: "Automatically address feedback",
          },
        },
      },
    },
    handler,
  };
}
