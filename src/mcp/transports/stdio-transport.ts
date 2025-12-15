import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { MCPServer } from "../server.js";
import { logger } from "../../infra/logger.js";

/**
 * Create and connect a stdio transport for the MCP server
 *
 * This is the simplest transport, used for local communication with
 * Claude Desktop, Claude Code, or other MCP clients via stdin/stdout.
 */
export async function createStdioTransport(server: MCPServer): Promise<StdioServerTransport> {
  logger.info("Creating stdio transport");

  const transport = new StdioServerTransport();

  // Connect server to transport
  await server.connect(transport);

  logger.info("Stdio transport connected");

  return transport;
}

/**
 * Start MCP server with stdio transport
 *
 * This function sets up signal handlers and keeps the process running
 * until terminated.
 */
export async function startStdioServer(server: MCPServer): Promise<void> {
  logger.info("Starting MCP server with stdio transport");

  await createStdioTransport(server);

  // Set up graceful shutdown
  const shutdown = async (): Promise<void> => {
    logger.info("Shutting down MCP server");
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", error);
    void shutdown();
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", reason as Error);
    void shutdown();
  });

  logger.info("MCP server running (stdio mode)");

  // Keep process running - the transport handles stdin/stdout
  // The process will exit when the parent process closes stdin
}
