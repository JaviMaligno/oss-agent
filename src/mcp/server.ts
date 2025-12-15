import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { Config, MCPConfig } from "../types/config.js";
import type { StateManager } from "../core/state/state-manager.js";
import { logger } from "../infra/logger.js";
import { mapToMCPError } from "./middleware/error-handler.js";
import { createToolRegistry, type ToolRegistry } from "./tools/index.js";
import { createResourceRegistry, type ResourceRegistry } from "./resources/index.js";
import type { MCPContext } from "./types.js";

export interface MCPServerOptions {
  config: Config;
  stateManager: StateManager;
}

export interface MCPServerDependencies {
  config: Config;
  stateManager: StateManager;
}

/**
 * MCP Server for oss-agent
 *
 * Exposes oss-agent capabilities as MCP tools and resources for use by
 * Claude Desktop, Claude Code, or other MCP-compatible clients.
 */
export class MCPServer {
  private server: Server;
  private config: Config;
  private mcpConfig: MCPConfig;
  private stateManager: StateManager;
  private toolRegistry: ToolRegistry;
  private resourceRegistry: ResourceRegistry;
  private activeOperations: Map<string, AbortController> = new Map();

  constructor(options: MCPServerOptions) {
    this.config = options.config;
    this.mcpConfig = options.config.mcp ?? {
      enabled: false,
      transports: {
        stdio: { enabled: true },
        http: {
          enabled: false,
          port: 3000,
          host: "127.0.0.1",
          requireAuth: true,
          cors: { enabled: false, origins: [] },
        },
      },
      auth: { apiKeys: [] },
      rateLimit: { enabled: true, maxRequestsPerMinute: 60, maxConcurrentOps: 3 },
      tools: { disabled: [], timeouts: {} },
    };
    this.stateManager = options.stateManager;

    // Initialize MCP server
    this.server = new Server(
      {
        name: "oss-agent",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    // Initialize registries
    this.toolRegistry = createToolRegistry({
      config: this.config,
      stateManager: this.stateManager,
    });

    this.resourceRegistry = createResourceRegistry({
      config: this.config,
      stateManager: this.stateManager,
    });

    // Set up handlers
    this.setupToolHandlers();
    this.setupResourceHandlers();
    this.setupErrorHandlers();
  }

  /**
   * Connect the server to a transport
   */
  async connect(transport: Transport): Promise<void> {
    logger.info("Connecting MCP server to transport");
    await this.server.connect(transport);
    logger.info("MCP server connected");
  }

  /**
   * Close the server and clean up
   */
  async close(): Promise<void> {
    logger.info("Closing MCP server");

    // Cancel all active operations
    for (const [opId, controller] of this.activeOperations) {
      logger.debug(`Cancelling operation ${opId}`);
      controller.abort();
    }
    this.activeOperations.clear();

    await this.server.close();
    logger.info("MCP server closed");
  }

  /**
   * Set up tool request handlers
   */
  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.toolRegistry.listTools();

      // Filter out disabled tools
      const enabledTools = tools.filter(
        (tool) => !this.mcpConfig.tools.disabled.includes(tool.name)
      );

      logger.debug(`Listing ${enabledTools.length} tools`);

      return { tools: enabledTools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      logger.info(`Tool call: ${name}`, { args });

      // Check if tool is disabled
      if (this.mcpConfig.tools.disabled.includes(name)) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool '${name}' is disabled`);
      }

      // Get tool handler
      const handler = this.toolRegistry.getHandler(name);
      if (!handler) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      // Create operation context
      const operationId = `${name}-${Date.now()}`;
      const abortController = new AbortController();
      this.activeOperations.set(operationId, abortController);

      const context: MCPContext = {
        sendProgress: async (params) => {
          // Progress notifications would be sent via server.notification()
          // For now, log progress
          logger.debug(`Progress: ${params.message}`, {
            progress: params.progress,
            total: params.total,
          });
        },
        isCancelled: () => abortController.signal.aborted,
      };

      try {
        // Get timeout for this tool
        const timeout = this.mcpConfig.tools.timeouts[name] ?? 300000; // 5 min default

        // Execute with timeout
        const result = await Promise.race([
          handler(args ?? {}, context),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(
                new McpError(ErrorCode.InternalError, `Tool '${name}' timed out after ${timeout}ms`)
              );
            }, timeout);
          }),
        ]);

        logger.info(`Tool ${name} completed`, { success: result.success });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error(`Tool ${name} failed`, { error });
        throw mapToMCPError(error);
      } finally {
        this.activeOperations.delete(operationId);
      }
    });
  }

  /**
   * Set up resource request handlers
   */
  private setupResourceHandlers(): void {
    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = this.resourceRegistry.listResources();
      logger.debug(`Listing ${resources.length} resources`);
      return { resources };
    });

    // Read resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      logger.debug(`Reading resource: ${uri}`);

      try {
        const content = await this.resourceRegistry.readResource(uri);
        return { contents: [content] };
      } catch (error) {
        logger.error(`Failed to read resource: ${uri}`, { error });
        throw mapToMCPError(error);
      }
    });
  }

  /**
   * Set up error handlers
   */
  private setupErrorHandlers(): void {
    this.server.onerror = (error): void => {
      logger.error("MCP server error", { error });
    };
  }

  /**
   * Get the underlying MCP server instance
   */
  getServer(): Server {
    return this.server;
  }
}

/**
 * Create and configure an MCP server instance
 */
export function createMCPServer(options: MCPServerOptions): MCPServer {
  return new MCPServer(options);
}
