/**
 * MCP Audit Tools
 *
 * Implements audit_repository, list_audit_runs, get_audit_findings,
 * approve_finding, reject_finding
 */

import type { Config } from "../../types/config.js";
import type { StateManager } from "../../core/state/state-manager.js";
import type { MCPContext, ToolResult } from "../types.js";
import type { RegisteredTool, ToolHandler } from "./index.js";
import { AuditService } from "../../core/audit/audit-service.js";
import { FindingProcessor } from "../../core/audit/finding-processor.js";
import { GitOperations } from "../../core/git/git-operations.js";
import { createProvider } from "../../core/ai/provider-factory.js";
import { expandPath } from "../../cli/config/loader.js";
import { logger } from "../../infra/logger.js";
import { AuditCategory, AuditFindingStatus } from "../../types/audit.js";

/**
 * Helper to create GitOperations with proper config
 */
function createGitOperations(config: Config): GitOperations {
  const dataDir = expandPath(config.dataDir);
  return new GitOperations(config.git, dataDir, config.hardening);
}

export interface AuditToolsOptions {
  config: Config;
  stateManager: StateManager;
}

/**
 * Create audit tool handlers
 */
export function createAuditTools(options: AuditToolsOptions): RegisteredTool[] {
  const { config, stateManager } = options;

  return [
    createAuditRepositoryTool(config, stateManager),
    createListAuditRunsTool(config, stateManager),
    createGetAuditFindingsTool(config, stateManager),
    createApproveFindingTool(config, stateManager),
    createRejectFindingTool(config, stateManager),
  ];
}

/**
 * audit_repository - Run an audit on a repository
 */
function createAuditRepositoryTool(config: Config, stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const repoUrl = args["repoUrl"] as string;
    const categories = args["categories"] as string[] | undefined;
    const skipIssueCreation = args["skipIssueCreation"] as boolean | undefined;
    const minSeverity = args["minSeverity"] as string | undefined;
    const minConfidence = args["minConfidence"] as string | undefined;

    if (!repoUrl) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "repoUrl is required",
        },
      };
    }

    // Validate URL format
    if (!repoUrl.match(/github\.com\/[^/]+\/[^/]+/)) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Invalid GitHub repository URL format",
        },
      };
    }

    try {
      // Initialize dependencies
      const gitOps = createGitOperations(config);
      const aiProvider = await createProvider(config);

      const auditService = new AuditService(config, stateManager, gitOps, aiProvider);

      // Build audit options with proper optional handling
      const auditOptions: {
        repoUrl: string;
        categories?: AuditCategory[];
        skipIssueCreation?: boolean;
        minSeverity?: "critical" | "high" | "medium" | "low" | "info";
        minConfidence?: "high" | "medium" | "low";
      } = { repoUrl };

      if (categories !== undefined) {
        auditOptions.categories = categories as AuditCategory[];
      }
      if (skipIssueCreation !== undefined) {
        auditOptions.skipIssueCreation = skipIssueCreation;
      }
      if (minSeverity !== undefined) {
        auditOptions.minSeverity = minSeverity as "critical" | "high" | "medium" | "low" | "info";
      }
      if (minConfidence !== undefined) {
        auditOptions.minConfidence = minConfidence as "high" | "medium" | "low";
      }

      const result = await auditService.auditRepository(auditOptions);

      return {
        success: true,
        data: {
          runId: result.run.id,
          projectId: result.run.projectId,
          status: result.run.status,
          totalFindings: result.summary.totalFindings,
          bySeverity: result.summary.bySeverity,
          byCategory: result.summary.byCategory,
          byStatus: result.summary.byStatus,
          durationMs: result.run.durationMs,
          costUsd: result.run.costUsd,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`audit_repository failed: ${message}`);
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
      name: "audit_repository",
      description: "Run an audit on a repository to find potential issues",
      inputSchema: {
        type: "object",
        properties: {
          repoUrl: {
            type: "string",
            description: "Repository URL to audit",
          },
          categories: {
            type: "array",
            items: {
              type: "string",
              enum: ["security", "performance", "documentation", "code-quality", "test-coverage"],
            },
            description: "Categories to audit (default: security, documentation, code-quality)",
          },
          skipIssueCreation: {
            type: "boolean",
            description: "Skip creating GitHub issues for findings",
          },
          minSeverity: {
            type: "string",
            enum: ["critical", "high", "medium", "low", "info"],
            description: "Minimum severity level (default: medium)",
          },
          minConfidence: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "Minimum confidence level (default: medium)",
          },
        },
        required: ["repoUrl"],
      },
    },
    handler,
  };
}

/**
 * list_audit_runs - List audit runs for a project
 */
function createListAuditRunsTool(_config: Config, stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const projectId = args["projectId"] as string | undefined;
    const limit = (args["limit"] as number) ?? 20;

    try {
      let runs;
      if (projectId) {
        runs = stateManager.getAuditRunsByProject(projectId);
      } else {
        // Get all runs - we'll need to query all projects
        // For now, return empty if no projectId specified
        // TODO: Add getAllAuditRuns method to StateManager
        return {
          success: true,
          data: {
            runs: [],
            message: "Please specify a projectId to list audit runs",
          },
        };
      }

      const limitedRuns = runs.slice(0, limit);

      return {
        success: true,
        data: {
          runs: limitedRuns.map((run) => ({
            id: run.id,
            projectId: run.projectId,
            status: run.status,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            categories: run.categories,
            totalFindings: run.totalFindings,
            criticalFindings: run.criticalFindings,
            highFindings: run.highFindings,
            mediumFindings: run.mediumFindings,
            lowFindings: run.lowFindings,
            costUsd: run.costUsd,
            durationMs: run.durationMs,
          })),
          count: limitedRuns.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`list_audit_runs failed: ${message}`);
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
      name: "list_audit_runs",
      description: "List audit runs for a project",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "Project ID to filter by (e.g., 'owner/repo')",
          },
          limit: {
            type: "number",
            description: "Maximum number of runs to return (default: 20)",
          },
        },
      },
    },
    handler,
  };
}

/**
 * get_audit_findings - Get findings from an audit run
 */
function createGetAuditFindingsTool(_config: Config, stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const auditRunId = args["auditRunId"] as string;
    const status = args["status"] as string | undefined;
    const severity = args["severity"] as string | undefined;
    const category = args["category"] as string | undefined;

    if (!auditRunId) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "auditRunId is required",
        },
      };
    }

    try {
      // Build filters with proper optional handling
      const filters: {
        status?: AuditFindingStatus;
        severity?: "critical" | "high" | "medium" | "low" | "info";
        category?: AuditCategory;
      } = {};

      if (status !== undefined) {
        filters.status = status as AuditFindingStatus;
      }
      if (severity !== undefined) {
        filters.severity = severity as "critical" | "high" | "medium" | "low" | "info";
      }
      if (category !== undefined) {
        filters.category = category as AuditCategory;
      }

      const findings = stateManager.getAuditFindings(auditRunId, filters);

      return {
        success: true,
        data: {
          findings: findings.map((f) => ({
            id: f.id,
            auditRunId: f.auditRunId,
            category: f.category,
            severity: f.severity,
            confidence: f.confidence,
            title: f.title,
            description: f.description,
            filePath: f.filePath,
            lineNumber: f.lineNumber,
            codeSnippet: f.codeSnippet,
            recommendation: f.recommendation,
            status: f.status,
            issueUrl: f.issueUrl,
            createdAt: f.createdAt,
            updatedAt: f.updatedAt,
          })),
          count: findings.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`get_audit_findings failed: ${message}`);
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
      name: "get_audit_findings",
      description: "Get findings from an audit run",
      inputSchema: {
        type: "object",
        properties: {
          auditRunId: {
            type: "string",
            description: "Audit run ID",
          },
          status: {
            type: "string",
            enum: ["pending", "approved", "rejected", "issue_created", "resolved"],
            description: "Filter by status",
          },
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low", "info"],
            description: "Filter by severity",
          },
          category: {
            type: "string",
            enum: ["security", "performance", "documentation", "code-quality", "test-coverage"],
            description: "Filter by category",
          },
        },
        required: ["auditRunId"],
      },
    },
    handler,
  };
}

/**
 * approve_finding - Approve a finding and optionally create an issue
 */
function createApproveFindingTool(config: Config, stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const findingId = args["findingId"] as string;
    const createIssue = args["createIssue"] as boolean | undefined;

    if (!findingId) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "findingId is required",
        },
      };
    }

    try {
      // Get the finding
      const finding = stateManager.getAuditFinding(findingId);
      if (!finding) {
        return {
          success: false,
          error: {
            code: "NOT_FOUND",
            message: `Finding ${findingId} not found`,
          },
        };
      }

      // Update finding status to approved
      stateManager.updateAuditFinding(findingId, {
        status: "approved",
      });

      let issueUrl: string | undefined;

      if (createIssue) {
        // Create GitHub issue using FindingProcessor
        const auditConfig = {
          ...config.audit,
          issueCreation: {
            ...config.audit.issueCreation,
            autoCreateSeverities: config.audit.issueCreation.autoCreateSeverities ?? [],
          },
          autoResolve: {
            ...config.audit.autoResolve,
            categories: config.audit.autoResolve.categories ?? [],
          },
        };
        const processor = new FindingProcessor(stateManager, auditConfig);
        const results = await processor.processFindings([finding]);
        issueUrl = results[0]?.issueUrl;

        if (!issueUrl) {
          logger.warn(`Failed to create issue for finding ${findingId}`);
        }
      }

      return {
        success: true,
        data: {
          findingId,
          status: "approved",
          issueUrl,
          issueCreated: !!issueUrl,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`approve_finding failed: ${message}`);
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
      name: "approve_finding",
      description: "Approve a finding and optionally create a GitHub issue",
      inputSchema: {
        type: "object",
        properties: {
          findingId: {
            type: "string",
            description: "Finding ID to approve",
          },
          createIssue: {
            type: "boolean",
            description: "Create a GitHub issue for this finding (default: false)",
          },
        },
        required: ["findingId"],
      },
    },
    handler,
  };
}

/**
 * reject_finding - Reject a finding as false positive
 */
function createRejectFindingTool(_config: Config, stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const findingId = args["findingId"] as string;
    const reason = args["reason"] as string | undefined;

    if (!findingId) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "findingId is required",
        },
      };
    }

    try {
      // Get the finding
      const finding = stateManager.getAuditFinding(findingId);
      if (!finding) {
        return {
          success: false,
          error: {
            code: "NOT_FOUND",
            message: `Finding ${findingId} not found`,
          },
        };
      }

      // Update finding status to rejected
      stateManager.updateAuditFinding(findingId, {
        status: "rejected",
      });

      // TODO: Store rejection reason in metadata
      if (reason) {
        logger.info(`Finding ${findingId} rejected: ${reason}`);
      }

      return {
        success: true,
        data: {
          findingId,
          status: "rejected",
          reason,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`reject_finding failed: ${message}`);
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
      name: "reject_finding",
      description: "Reject a finding as a false positive",
      inputSchema: {
        type: "object",
        properties: {
          findingId: {
            type: "string",
            description: "Finding ID to reject",
          },
          reason: {
            type: "string",
            description: "Reason for rejection (optional)",
          },
        },
        required: ["findingId"],
      },
    },
    handler,
  };
}
