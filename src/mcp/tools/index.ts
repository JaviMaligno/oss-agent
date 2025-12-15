import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../../types/config.js";
import type { StateManager } from "../../core/state/state-manager.js";
import type { MCPContext, ToolResult } from "../types.js";
import { hardenToolHandler, type MCPHardeningConfig } from "../hardening.js";
import { logger } from "../../infra/logger.js";

// Import tool modules
import { createWorkflowTools } from "./workflow-tools.js";
import { createDiscoveryTools } from "./discovery-tools.js";
import { createQueueTools } from "./queue-tools.js";
import { createAutonomousTools } from "./autonomous-tools.js";
import { createMonitoringTools } from "./monitoring-tools.js";
import { createManagementTools } from "./management-tools.js";

export interface ToolRegistryOptions {
  config: Config;
  stateManager: StateManager;
  /** Enable hardening (circuit breakers, watchdogs). Defaults to true. */
  hardeningEnabled?: boolean;
  /** Custom hardening configuration */
  hardeningConfig?: Partial<MCPHardeningConfig>;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: MCPContext
) => Promise<ToolResult>;

export interface RegisteredTool {
  definition: Tool;
  handler: ToolHandler;
}

export interface ToolRegistry {
  listTools(): Tool[];
  getHandler(name: string): ToolHandler | undefined;
  register(tool: RegisteredTool): void;
}

/**
 * Long-running tools that benefit from hardening (circuit breakers + watchdogs)
 */
const HARDENED_TOOLS = new Set([
  "work_on_issue",
  "iterate_on_feedback",
  "resume_session",
  "watch_prs",
  "run_autonomous",
  "work_parallel",
  "discover_projects",
  "suggest_issues",
]);

/**
 * Wrap a tool handler with hardening if appropriate
 */
function maybeHarden(
  tool: RegisteredTool,
  hardeningEnabled: boolean,
  hardeningConfig?: Partial<MCPHardeningConfig>
): RegisteredTool {
  // Only harden long-running tools
  if (!hardeningEnabled || !HARDENED_TOOLS.has(tool.definition.name)) {
    return tool;
  }

  logger.debug(`Applying hardening to tool: ${tool.definition.name}`);

  return {
    definition: tool.definition,
    handler: hardenToolHandler(tool.definition.name, tool.handler, hardeningConfig),
  };
}

/**
 * Create a tool registry with all MCP tools
 */
export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const tools = new Map<string, RegisteredTool>();
  const hardeningEnabled = options.hardeningEnabled ?? true;
  const hardeningConfig = options.hardeningConfig;

  // Register workflow tools (Phase 3 - implemented)
  const workflowTools = createWorkflowTools(options);
  for (const tool of workflowTools) {
    tools.set(tool.definition.name, maybeHarden(tool, hardeningEnabled, hardeningConfig));
  }

  // Register discovery tools (Phase 4 - implemented)
  const discoveryTools = createDiscoveryTools(options);
  for (const tool of discoveryTools) {
    tools.set(tool.definition.name, maybeHarden(tool, hardeningEnabled, hardeningConfig));
  }

  // Register queue tools (Phase 4 - implemented)
  const queueTools = createQueueTools(options);
  for (const tool of queueTools) {
    tools.set(tool.definition.name, maybeHarden(tool, hardeningEnabled, hardeningConfig));
  }

  // Register autonomous tools (Phase 5 - implemented)
  const autonomousTools = createAutonomousTools(options);
  for (const tool of autonomousTools) {
    tools.set(tool.definition.name, maybeHarden(tool, hardeningEnabled, hardeningConfig));
  }

  // Register monitoring tools (Phase 5 - implemented)
  const monitoringTools = createMonitoringTools(options);
  for (const tool of monitoringTools) {
    tools.set(tool.definition.name, maybeHarden(tool, hardeningEnabled, hardeningConfig));
  }

  // Register management tools (Phase 5 - implemented)
  const managementTools = createManagementTools(options);
  for (const tool of managementTools) {
    tools.set(tool.definition.name, maybeHarden(tool, hardeningEnabled, hardeningConfig));
  }

  // Register placeholder tools for remaining tools
  registerPlaceholderTools(tools, options, hardeningEnabled, hardeningConfig);

  return {
    listTools(): Tool[] {
      return Array.from(tools.values()).map((t) => t.definition);
    },

    getHandler(name: string): ToolHandler | undefined {
      return tools.get(name)?.handler;
    },

    register(tool: RegisteredTool): void {
      tools.set(tool.definition.name, tool);
    },
  };
}

/**
 * Register placeholder tools for initial implementation
 * These provide the tool definitions but return "not implemented" until
 * the actual handlers are built in subsequent phases
 */
function registerPlaceholderTools(
  tools: Map<string, RegisteredTool>,
  _options: ToolRegistryOptions,
  _hardeningEnabled: boolean,
  _hardeningConfig?: Partial<MCPHardeningConfig>
): void {
  const placeholderHandler: ToolHandler = async () => ({
    success: false,
    error: {
      code: "NOT_IMPLEMENTED",
      message: "This tool is not yet implemented",
    },
  });

  // Note: Workflow tools (work_on_issue, iterate_on_feedback, resume_session, watch_prs)
  // are now registered by createWorkflowTools() above

  // Discovery Tools
  tools.set("discover_projects", {
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
    handler: placeholderHandler,
  });

  tools.set("suggest_issues", {
    definition: {
      name: "suggest_issues",
      description: "Suggest issues to work on from a project or queue",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "Project ID to suggest issues from",
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
    handler: placeholderHandler,
  });

  // Queue Tools
  tools.set("queue_list", {
    definition: {
      name: "queue_list",
      description: "List all issues in the work queue",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: placeholderHandler,
  });

  tools.set("queue_add", {
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
    handler: placeholderHandler,
  });

  tools.set("queue_remove", {
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
        },
        required: ["issueId"],
      },
    },
    handler: placeholderHandler,
  });

  tools.set("queue_prioritize", {
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
          priority: {
            type: "number",
            description: "New priority value",
          },
        },
        required: ["issueId", "priority"],
      },
    },
    handler: placeholderHandler,
  });

  tools.set("queue_clear", {
    definition: {
      name: "queue_clear",
      description: "Clear all issues from the work queue",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: placeholderHandler,
  });

  // Autonomous Tools
  tools.set("run_autonomous", {
    definition: {
      name: "run_autonomous",
      description: "Run autonomous mode to process issues from the queue",
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
            description: "Simulate without making changes",
          },
        },
      },
    },
    handler: placeholderHandler,
  });

  tools.set("work_parallel", {
    definition: {
      name: "work_parallel",
      description: "Work on multiple issues in parallel",
      inputSchema: {
        type: "object",
        properties: {
          count: {
            type: "number",
            description: "Number of issues to work on in parallel",
          },
          issueUrls: {
            type: "array",
            items: { type: "string" },
            description: "Specific issue URLs (or use queue)",
          },
        },
        required: ["count"],
      },
    },
    handler: placeholderHandler,
  });

  tools.set("cancel_work", {
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
        },
        required: ["issueId"],
      },
    },
    handler: placeholderHandler,
  });

  tools.set("parallel_status", {
    definition: {
      name: "parallel_status",
      description: "Show status of parallel work operations",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: placeholderHandler,
  });

  // Monitoring Tools
  tools.set("get_pr_status", {
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
    handler: placeholderHandler,
  });

  tools.set("get_session_history", {
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
    handler: placeholderHandler,
  });

  tools.set("get_status", {
    definition: {
      name: "get_status",
      description: "Get overall system status including budget, queue, and health",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: placeholderHandler,
  });

  // Management Tools
  tools.set("get_config", {
    definition: {
      name: "get_config",
      description: "Get current configuration",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Specific config key (dot notation)",
          },
        },
      },
    },
    handler: placeholderHandler,
  });

  tools.set("update_config", {
    definition: {
      name: "update_config",
      description: "Update configuration value",
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
    handler: placeholderHandler,
  });

  tools.set("cleanup_worktrees", {
    definition: {
      name: "cleanup_worktrees",
      description: "Clean up old git worktrees",
      inputSchema: {
        type: "object",
        properties: {
          olderThanHours: {
            type: "number",
            description: "Only cleanup older than N hours",
          },
          projectId: {
            type: "string",
            description: "Only cleanup for specific project",
          },
          force: {
            type: "boolean",
            description: "Force cleanup even if in use",
          },
        },
      },
    },
    handler: placeholderHandler,
  });
}

/**
 * Helper to convert Zod schema to JSON Schema for MCP tool definitions
 * This is a simplified version - in production, consider using zod-to-json-schema
 */
export function zodToJsonSchema(_zodSchema: unknown): Record<string, unknown> {
  // Placeholder - would use zod-to-json-schema library
  return {
    type: "object",
    properties: {},
  };
}
