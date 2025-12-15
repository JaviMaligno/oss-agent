import type { Resource, ResourceContents } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../../types/config.js";
import type { StateManager } from "../../core/state/state-manager.js";
import { logger } from "../../infra/logger.js";
import { ConfigurationError } from "../../infra/errors.js";

export interface ResourceRegistryOptions {
  config: Config;
  stateManager: StateManager;
}

export type ResourceHandler = (uri: string) => Promise<ResourceContents>;

export interface RegisteredResource {
  definition: Resource;
  handler: ResourceHandler;
}

export interface ResourceRegistry {
  listResources(): Resource[];
  readResource(uri: string): Promise<ResourceContents>;
  register(resource: RegisteredResource): void;
}

/**
 * Create a resource registry with all MCP resources
 */
export function createResourceRegistry(options: ResourceRegistryOptions): ResourceRegistry {
  const resources = new Map<string, RegisteredResource>();
  const { config, stateManager } = options;

  // Register all resources
  registerConfigResources(resources, config);
  registerStateResources(resources, stateManager);
  registerQueueResources(resources, stateManager);
  registerOperationsResources(resources);

  return {
    listResources(): Resource[] {
      return Array.from(resources.values()).map((r) => r.definition);
    },

    async readResource(uri: string): Promise<ResourceContents> {
      // Find matching resource handler
      // First try exact match
      const exactMatch = resources.get(uri);
      if (exactMatch) {
        return exactMatch.handler(uri);
      }

      // Then try pattern matching for parameterized URIs
      for (const [pattern, resource] of resources) {
        if (matchesResourcePattern(uri, pattern)) {
          return resource.handler(uri);
        }
      }

      throw new ConfigurationError(`Unknown resource: ${uri}`);
    },

    register(resource: RegisteredResource): void {
      resources.set(resource.definition.uri, resource);
    },
  };
}

/**
 * Check if a URI matches a resource pattern
 * Patterns use {param} syntax for dynamic segments
 */
function matchesResourcePattern(uri: string, pattern: string): boolean {
  // Convert pattern to regex
  // e.g., "operations://{id}" -> /^operations:\/\/(.+)$/
  const regexPattern = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // Escape special chars
    .replace(/\\{\\w+\\}/g, "(.+)"); // Replace {param} with capture group

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(uri);
}

/**
 * Parse query parameters from a resource URI
 */
function parseQueryParams(uri: string): Record<string, string> {
  const questionIndex = uri.indexOf("?");
  if (questionIndex === -1) return {};

  const queryString = uri.slice(questionIndex + 1);
  const params: Record<string, string> = {};

  for (const pair of queryString.split("&")) {
    const [key, value] = pair.split("=");
    if (key && value !== undefined) {
      params[decodeURIComponent(key)] = decodeURIComponent(value);
    }
  }

  return params;
}

/**
 * Register configuration resources
 */
function registerConfigResources(resources: Map<string, RegisteredResource>, config: Config): void {
  // Current configuration
  resources.set("config://current", {
    definition: {
      uri: "config://current",
      name: "Current Configuration",
      description: "Current oss-agent configuration (sensitive values redacted)",
      mimeType: "application/json",
    },
    handler: async () => {
      logger.debug("Reading config://current");

      // Redact sensitive values
      const sanitizedConfig = sanitizeConfig(config);

      return {
        uri: "config://current",
        mimeType: "application/json",
        text: JSON.stringify(sanitizedConfig, null, 2),
      };
    },
  });

  // Default configuration
  resources.set("config://defaults", {
    definition: {
      uri: "config://defaults",
      name: "Default Configuration",
      description: "Default configuration values",
      mimeType: "application/json",
    },
    handler: async () => {
      logger.debug("Reading config://defaults");

      // Return default config structure
      const defaults = {
        ai: {
          provider: "claude",
          executionMode: "cli",
          model: "claude-sonnet-4-20250514",
        },
        budget: {
          dailyLimitUsd: 50,
          monthlyLimitUsd: 500,
          perIssueLimitUsd: 5,
          perFeedbackIterationUsd: 2,
        },
        git: {
          defaultBranch: "main",
          commitSignoff: false,
          branchPrefix: "oss-agent",
          existingBranchStrategy: "auto-clean",
        },
      };

      return {
        uri: "config://defaults",
        mimeType: "application/json",
        text: JSON.stringify(defaults, null, 2),
      };
    },
  });
}

/**
 * Register state resources
 */
function registerStateResources(
  resources: Map<string, RegisteredResource>,
  stateManager: StateManager
): void {
  // Issues by state
  resources.set("state://issues", {
    definition: {
      uri: "state://issues",
      name: "Issues",
      description: "Query issues by state. Params: state, limit",
      mimeType: "application/json",
    },
    handler: async (uri) => {
      const params = parseQueryParams(uri);
      logger.debug("Reading state://issues", { params });

      const state = params["state"] as
        | "discovered"
        | "queued"
        | "in_progress"
        | "pr_created"
        | undefined;
      const limit = params["limit"] ? parseInt(params["limit"], 10) : 50;

      let issues;
      if (state) {
        issues = stateManager.getIssuesByState(state).slice(0, limit);
      } else {
        // Return queued issues by default
        issues = stateManager.getIssuesByState("queued").slice(0, limit);
      }

      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ issues, count: issues.length }, null, 2),
      };
    },
  });

  // Sessions
  resources.set("state://sessions", {
    definition: {
      uri: "state://sessions",
      name: "Sessions",
      description: "Query sessions. Params: limit",
      mimeType: "application/json",
    },
    handler: async (uri) => {
      const params = parseQueryParams(uri);
      logger.debug("Reading state://sessions", { params });

      // Get active sessions (available method)
      const sessions = stateManager.getActiveSessions();

      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ sessions, count: sessions.length }, null, 2),
      };
    },
  });

  // Audit log
  resources.set("state://audit-log", {
    definition: {
      uri: "state://audit-log",
      name: "Audit Log",
      description: "Issue state transition audit log. Params: issueId",
      mimeType: "application/json",
    },
    handler: async (uri) => {
      const params = parseQueryParams(uri);
      logger.debug("Reading state://audit-log", { params });

      const issueId = params["issueId"];

      if (!issueId) {
        return {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            { transitions: [], count: 0, message: "Provide issueId parameter" },
            null,
            2
          ),
        };
      }

      const transitions = stateManager.getIssueTransitions(issueId);

      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ transitions, count: transitions.length }, null, 2),
      };
    },
  });
}

/**
 * Register queue resources
 */
function registerQueueResources(
  resources: Map<string, RegisteredResource>,
  stateManager: StateManager
): void {
  // Current queue
  resources.set("queue://current", {
    definition: {
      uri: "queue://current",
      name: "Current Queue",
      description: "Issues currently in the work queue",
      mimeType: "application/json",
    },
    handler: async (uri) => {
      logger.debug("Reading queue://current");

      const queuedIssues = stateManager.getIssuesByState("queued");

      // Map to simplified queue format
      const queue = queuedIssues.map((issue) => ({
        id: issue.id,
        url: issue.url,
        title: issue.title,
        projectId: issue.projectId,
      }));

      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ queue, size: queue.length }, null, 2),
      };
    },
  });

  // Queue stats
  resources.set("queue://stats", {
    definition: {
      uri: "queue://stats",
      name: "Queue Statistics",
      description: "Queue statistics and thresholds",
      mimeType: "application/json",
    },
    handler: async (uri) => {
      logger.debug("Reading queue://stats");

      const queuedIssues = stateManager.getIssuesByState("queued");
      const inProgressIssues = stateManager.getIssuesByState("in_progress");

      const stats = {
        size: queuedIssues.length,
        inProgress: inProgressIssues.length,
        // These would come from config
        minSize: 5,
        targetSize: 20,
        autoReplenish: true,
      };

      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(stats, null, 2),
      };
    },
  });
}

/**
 * Register operations resources for async operation tracking
 */
function registerOperationsResources(resources: Map<string, RegisteredResource>): void {
  // In-memory operation store (would be replaced with persistent storage)
  const operations = new Map<
    string,
    {
      id: string;
      type: string;
      status: string;
      progress?: { current: number; total: number; message?: string };
      result?: unknown;
      error?: { code: string; message: string };
      startedAt: string;
      updatedAt: string;
      completedAt?: string;
    }
  >();

  // Operation status resource (pattern-matched)
  resources.set("operations://{id}", {
    definition: {
      uri: "operations://{id}",
      name: "Operation Status",
      description: "Status of an async operation by ID",
      mimeType: "application/json",
    },
    handler: async (uri) => {
      // Extract operation ID from URI
      const match = uri.match(/^operations:\/\/(.+)$/);
      const operationId = match?.[1];

      logger.debug("Reading operations://{id}", { operationId });

      if (!operationId) {
        throw new ConfigurationError("Invalid operation URI");
      }

      const operation = operations.get(operationId);
      if (!operation) {
        return {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              id: operationId,
              status: "not_found",
              message: "Operation not found or has expired",
            },
            null,
            2
          ),
        };
      }

      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(operation, null, 2),
      };
    },
  });
}

/**
 * Sanitize configuration by removing sensitive values
 */
function sanitizeConfig(config: Config): Record<string, unknown> {
  const sanitized = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;

  // Redact API keys and tokens
  const redactPaths = [
    "ai.apiKey",
    "b2b.jira.apiToken",
    "b2b.linear.apiKey",
    "b2b.sentry.authToken",
    "b2b.githubEnterprise.token",
    "b2b.gitlab.token",
    "b2b.bitbucket.appPassword",
    "mcp.auth.apiKeys",
  ];

  for (const path of redactPaths) {
    const parts = path.split(".");
    let obj = sanitized as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (part && obj[part] && typeof obj[part] === "object") {
        obj = obj[part] as Record<string, unknown>;
      } else {
        break;
      }
    }
    const lastPart = parts[parts.length - 1];
    if (lastPart && lastPart in obj) {
      if (Array.isArray(obj[lastPart])) {
        obj[lastPart] = "[REDACTED]";
      } else if (obj[lastPart]) {
        obj[lastPart] = "[REDACTED]";
      }
    }
  }

  return sanitized;
}
