// MCP Server module
// Exposes oss-agent capabilities as MCP tools and resources

export { MCPServer, createMCPServer, type MCPServerOptions } from "./server.js";
export { createStdioTransport, startStdioServer } from "./transports/stdio-transport.js";
export {
  createHttpTransport,
  startHttpServer,
  createHttpTransportOptions,
  type HttpTransport,
  type HttpTransportOptions,
} from "./transports/http-transport.js";
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
export { createAuthMiddleware, type AuthConfig, type MCPAuthInfo } from "./middleware/auth.js";
export {
  createRateLimitMiddleware,
  RateLimiter,
  type RateLimitConfig,
  type RateLimitResult,
} from "./middleware/rate-limit.js";
export {
  hardenToolHandler,
  HardenedToolHandler,
  getMCPCircuitStatus,
  resetAllMCPCircuits,
  isMCPHealthy,
  MCP_CIRCUIT_OPERATIONS,
  DEFAULT_MCP_HARDENING_CONFIG,
  type MCPHardeningConfig,
  type MCPCircuitOperation,
} from "./hardening.js";
export * from "./types.js";
