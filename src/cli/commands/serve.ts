import { Command } from "commander";
import { loadConfig } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { createMCPServer } from "../../mcp/server.js";
import { startStdioServer } from "../../mcp/transports/stdio-transport.js";
import {
  startHttpServer,
  createHttpTransportOptions,
} from "../../mcp/transports/http-transport.js";
import { logger } from "../../infra/logger.js";

export function createServeCommand(): Command {
  const command = new Command("serve")
    .description("Start the MCP server to expose oss-agent capabilities as tools")
    .option("--stdio", "Use stdio transport (default, for Claude Desktop/Code)")
    .option("--http", "Use HTTP/SSE transport")
    .option("--port <port>", "HTTP server port", "3000")
    .option("--host <host>", "HTTP server host", "127.0.0.1")
    .option("--api-key <key>", "API key for HTTP authentication")
    .action(async (options) => {
      try {
        const config = await loadConfig();

        // Default to stdio if no transport specified
        const useStdio = options.stdio ?? !options.http;
        const useHttp = options.http;

        if (!useStdio && !useHttp) {
          logger.error("At least one transport must be enabled (--stdio or --http)");
          process.exit(1);
        }

        // Initialize state manager
        const dataDir = config.dataDir.replace("~", process.env["HOME"] ?? "");
        const stateManager = new StateManager(dataDir);

        // Create MCP server
        const server = createMCPServer({
          config,
          stateManager,
        });

        // Start transports
        if (useStdio && !useHttp) {
          // Stdio only mode
          logger.info("Starting MCP server with stdio transport");
          await startStdioServer(server);
        } else if (useHttp && !useStdio) {
          // HTTP only mode
          logger.info("Starting MCP server with HTTP transport");

          // Merge CLI options with config
          const mcpConfig = config.mcp ?? {
            enabled: true,
            transports: {
              stdio: { enabled: false },
              http: {
                enabled: true,
                port: parseInt(options.port, 10),
                host: options.host,
                requireAuth: !!options.apiKey,
                cors: { enabled: false, origins: [] },
              },
            },
            auth: {
              apiKeys: options.apiKey ? [options.apiKey] : [],
            },
            rateLimit: {
              enabled: true,
              maxRequestsPerMinute: 60,
              maxConcurrentOps: 3,
            },
            tools: { disabled: [], timeouts: {} },
          };

          // Override with CLI options
          mcpConfig.transports.http.port = parseInt(options.port, 10);
          mcpConfig.transports.http.host = options.host;
          if (options.apiKey) {
            mcpConfig.auth.apiKeys = [options.apiKey, ...mcpConfig.auth.apiKeys];
            mcpConfig.transports.http.requireAuth = true;
          }

          const httpOptions = createHttpTransportOptions(mcpConfig);
          await startHttpServer(server, httpOptions);
        } else if (useStdio && useHttp) {
          // Both transports - start HTTP first, then stdio
          logger.info("Starting MCP server with both stdio and HTTP transports");

          // Merge CLI options with config for HTTP
          const mcpConfig = config.mcp ?? {
            enabled: true,
            transports: {
              stdio: { enabled: true },
              http: {
                enabled: true,
                port: parseInt(options.port, 10),
                host: options.host,
                requireAuth: !!options.apiKey,
                cors: { enabled: false, origins: [] },
              },
            },
            auth: {
              apiKeys: options.apiKey ? [options.apiKey] : [],
            },
            rateLimit: {
              enabled: true,
              maxRequestsPerMinute: 60,
              maxConcurrentOps: 3,
            },
            tools: { disabled: [], timeouts: {} },
          };

          // Override with CLI options
          mcpConfig.transports.http.port = parseInt(options.port, 10);
          mcpConfig.transports.http.host = options.host;
          if (options.apiKey) {
            mcpConfig.auth.apiKeys = [options.apiKey, ...mcpConfig.auth.apiKeys];
            mcpConfig.transports.http.requireAuth = true;
          }

          // Start HTTP transport (non-blocking)
          const httpOptions = createHttpTransportOptions(mcpConfig);
          const { startHttpServer: startHttp } =
            await import("../../mcp/transports/http-transport.js");
          await startHttp(server, httpOptions);

          // Note: stdio server takes over the process
          // For true dual-transport, we'd need a second server instance
          logger.warn(
            "Dual transport mode: HTTP server running. Stdio is not active in this mode."
          );
        }
      } catch (error) {
        logger.error("Failed to start MCP server", error as Error);
        process.exit(1);
      }
    });

  return command;
}
