/**
 * MCP Discovery Tools
 *
 * Implements discover_projects and suggest_issues
 */

import type { Config } from "../../types/config.js";
import type { StateManager } from "../../core/state/state-manager.js";
import type { MCPContext, ToolResult } from "../types.js";
import type { RegisteredTool, ToolHandler } from "./index.js";
import { DiscoveryService, DiscoveryConfig } from "../../oss/discovery/discovery-service.js";
import { SelectionService, SelectionConfig } from "../../oss/selection/selection-service.js";
import { createProvider } from "../../core/ai/provider-factory.js";
import { logger } from "../../infra/logger.js";

export interface DiscoveryToolsOptions {
  config: Config;
  stateManager: StateManager;
}

/**
 * Create discovery tool handlers
 */
export function createDiscoveryTools(options: DiscoveryToolsOptions): RegisteredTool[] {
  const { config, stateManager } = options;

  return [createDiscoverProjectsTool(config, stateManager), createSuggestIssuesTool(config)];
}

/**
 * discover_projects - Find OSS projects matching criteria
 */
function createDiscoverProjectsTool(config: Config, _stateManager: StateManager): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const mode = (args["mode"] as string) ?? "search";
    const language = args["language"] as string | undefined;
    const minStars = args["minStars"] as number | undefined;
    const maxStars = args["maxStars"] as number | undefined;
    const topics = args["topics"] as string[] | undefined;
    const domain = args["domain"] as string | undefined;
    const framework = args["framework"] as string | undefined;
    const limit = (args["limit"] as number) ?? 10;

    try {
      const discoveryService = new DiscoveryService(config.oss);

      // Set up AI provider for intelligent mode
      if (mode === "intelligent") {
        try {
          const aiProvider = await createProvider(config);
          discoveryService.setAIProvider(aiProvider);
        } catch (error) {
          logger.warn(`Could not initialize AI provider for intelligent mode: ${error}`);
        }
      }

      const discoveryConfig: DiscoveryConfig = {
        mode: mode as "direct" | "search" | "intelligent" | "curated",
      };

      if (language !== undefined) {
        discoveryConfig.language = language;
      }
      if (minStars !== undefined) {
        discoveryConfig.minStars = minStars;
      }
      if (maxStars !== undefined) {
        discoveryConfig.maxStars = maxStars;
      }
      if (topics !== undefined) {
        discoveryConfig.topics = topics;
      }
      if (domain !== undefined) {
        discoveryConfig.domain = domain;
      }
      if (framework !== undefined) {
        discoveryConfig.framework = framework;
      }

      const projects = await discoveryService.discover(discoveryConfig);

      // Limit results
      const limitedProjects = projects.slice(0, limit);

      return {
        success: true,
        data: {
          count: limitedProjects.length,
          projects: limitedProjects.map((p) => ({
            id: p.id,
            fullName: p.fullName,
            owner: p.owner,
            name: p.name,
            url: p.url,
            description: p.description,
            stars: p.stars,
            language: p.language,
            topics: p.topics,
            hasContributingGuide: p.hasContributingGuide,
            openIssues: p.openIssues,
          })),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`discover_projects failed: ${message}`);
      return {
        success: false,
        error: {
          code: "DISCOVERY_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "discover_projects",
      description: "Find OSS projects matching specified criteria",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["direct", "search", "intelligent", "curated"],
            description: "Discovery mode",
          },
          language: {
            type: "string",
            description: "Primary language filter",
          },
          minStars: {
            type: "number",
            description: "Minimum star count",
          },
          maxStars: {
            type: "number",
            description: "Maximum star count",
          },
          topics: {
            type: "array",
            items: { type: "string" },
            description: "Repository topics to filter by",
          },
          domain: {
            type: "string",
            description: "Domain category (ai-ml, devtools, etc.)",
          },
          framework: {
            type: "string",
            description: "Framework filter (react, fastapi, etc.)",
          },
          limit: {
            type: "number",
            description: "Maximum results to return",
          },
        },
      },
    },
    handler,
  };
}

/**
 * suggest_issues - Suggest issues to work on from a project
 */
function createSuggestIssuesTool(config: Config): RegisteredTool {
  const handler: ToolHandler = async (args, _context: MCPContext): Promise<ToolResult> => {
    const projectId = args["projectId"] as string | undefined;
    const repoUrl = args["repoUrl"] as string | undefined;
    const limit = (args["limit"] as number) ?? 10;
    const filterLabels = args["filterLabels"] as string[] | undefined;
    const excludeLabels = args["excludeLabels"] as string[] | undefined;

    // Need either projectId or repoUrl
    if (!projectId && !repoUrl) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Either projectId or repoUrl is required",
        },
      };
    }

    try {
      const discoveryService = new DiscoveryService(config.oss);
      const selectionService = new SelectionService(config.oss);

      // Get project info
      let targetRepo = projectId ?? "";
      if (repoUrl) {
        // Parse repo URL to get owner/repo
        const match = repoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
        if (match?.[1]) {
          targetRepo = match[1];
        } else {
          return {
            success: false,
            error: {
              code: "INVALID_ARGUMENT",
              message: "Invalid GitHub repository URL",
            },
          };
        }
      }

      // Get project info
      const project = await discoveryService.getProjectInfo(targetRepo);
      if (!project) {
        return {
          success: false,
          error: {
            code: "NOT_FOUND",
            message: `Project not found: ${targetRepo}`,
          },
        };
      }

      // Build selection config
      const selectionConfig: SelectionConfig = {
        limit,
      };
      if (filterLabels !== undefined) {
        selectionConfig.filterLabels = filterLabels;
      }
      if (excludeLabels !== undefined) {
        selectionConfig.excludeLabels = excludeLabels;
      }

      // Find issues
      const issues = await selectionService.findIssues(project, selectionConfig);

      return {
        success: true,
        data: {
          project: {
            fullName: project.fullName,
            url: project.url,
          },
          count: issues.length,
          issues: issues.map((issue) => ({
            number: issue.number,
            title: issue.title,
            url: issue.url,
            labels: issue.labels,
            author: issue.author,
            createdAt: issue.createdAt.toISOString(),
            updatedAt: issue.updatedAt.toISOString(),
            commentCount: issue.comments?.length ?? 0,
          })),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`suggest_issues failed: ${message}`);
      return {
        success: false,
        error: {
          code: "SELECTION_ERROR",
          message,
        },
      };
    }
  };

  return {
    definition: {
      name: "suggest_issues",
      description: "Suggest issues to work on from a project or queue",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "Project ID to suggest issues from (owner/repo format)",
          },
          repoUrl: {
            type: "string",
            description: "Repository URL to suggest issues from",
          },
          limit: {
            type: "number",
            description: "Maximum issues to return",
          },
          filterLabels: {
            type: "array",
            items: { type: "string" },
            description: "Labels to include",
          },
          excludeLabels: {
            type: "array",
            items: { type: "string" },
            description: "Labels to exclude",
          },
        },
      },
    },
    handler,
  };
}
