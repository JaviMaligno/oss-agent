// MCP Server module
// Exposes oss-agent capabilities as MCP tools and resources

export { MCPServer, createMCPServer, type MCPServerOptions } from "./server.js";
export { createStdioTransport, startStdioServer } from "./transports/stdio-transport.js";
export { createToolRegistry, type ToolRegistry, type ToolHandler } from "./tools/index.js";
export {
  createResourceRegistry,
  type ResourceRegistry,
  type ResourceHandler,
} from "./resources/index.js";
export {
  mapToMCPError,
  withMCPErrorHandling,
  createErrorResult,
  createSuccessResult,
} from "./middleware/error-handler.js";
export * from "./types.js";
