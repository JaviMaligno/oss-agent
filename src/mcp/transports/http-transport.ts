/**
 * MCP HTTP Transport
 *
 * Provides HTTP/SSE transport for the MCP server, enabling remote access
 * with authentication and rate limiting.
 *
 * Uses the MCP SDK's StreamableHTTPServerTransport under the hood.
 */

import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { randomUUID } from "node:crypto";
import type { MCPServer } from "../server.js";
import type { MCPConfig } from "../../types/config.js";
import { logger } from "../../infra/logger.js";
import { createAuthMiddleware, type AuthConfig } from "../middleware/auth.js";
import {
  createRateLimitMiddleware,
  type RateLimitConfig,
  type RateLimiter,
} from "../middleware/rate-limit.js";

/**
 * HTTP transport options
 */
export interface HttpTransportOptions {
  /** Port to listen on */
  port: number;
  /** Host to bind to */
  host: string;
  /** Whether authentication is required */
  requireAuth: boolean;
  /** Auth configuration */
  auth: AuthConfig;
  /** Rate limit configuration */
  rateLimit: RateLimitConfig;
  /** CORS configuration */
  cors?: {
    enabled: boolean;
    origins: string[];
  };
}

/**
 * HTTP transport instance
 */
export interface HttpTransport {
  /** The underlying HTTP server */
  server: HttpServer;
  /** The MCP transport */
  transport: StreamableHTTPServerTransport;
  /** The rate limiter instance */
  rateLimiter: RateLimiter;
  /** Stop the server */
  stop: () => Promise<void>;
}

/**
 * Create HTTP transport options from MCP config
 */
export function createHttpTransportOptions(mcpConfig: MCPConfig): HttpTransportOptions {
  return {
    port: mcpConfig.transports.http.port,
    host: mcpConfig.transports.http.host,
    requireAuth: mcpConfig.transports.http.requireAuth,
    auth: {
      apiKeys: mcpConfig.auth.apiKeys,
      apiKeysFile: mcpConfig.auth.apiKeysFile,
      required: mcpConfig.transports.http.requireAuth,
    },
    rateLimit: {
      enabled: mcpConfig.rateLimit.enabled,
      maxRequestsPerMinute: mcpConfig.rateLimit.maxRequestsPerMinute,
      maxConcurrentOps: mcpConfig.rateLimit.maxConcurrentOps,
    },
    cors: mcpConfig.transports.http.cors,
  };
}

/**
 * Middleware chain helper
 */
type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

function chainMiddleware(
  middlewares: Middleware[]
): (req: IncomingMessage, res: ServerResponse, final: () => void) => void {
  return (req: IncomingMessage, res: ServerResponse, final: () => void) => {
    let index = 0;

    const next = (): void => {
      if (index < middlewares.length) {
        const middleware = middlewares[index++];
        if (middleware) {
          middleware(req, res, next);
        }
      } else {
        final();
      }
    };

    next();
  };
}

/**
 * Create CORS middleware
 */
function createCorsMiddleware(config: { enabled: boolean; origins: string[] }): Middleware {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!config.enabled) {
      next();
      return;
    }

    const origin = req.headers.origin;

    // Check if origin is allowed
    const isAllowed =
      !origin ||
      config.origins.some((pattern) => {
        if (pattern === "*") return true;
        if (pattern.includes("*")) {
          const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
          return regex.test(origin);
        }
        return pattern === origin;
      });

    if (isAllowed && origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
    }

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    next();
  };
}

/**
 * Create and start HTTP transport for MCP server
 */
export async function createHttpTransport(
  server: MCPServer,
  options: HttpTransportOptions
): Promise<HttpTransport> {
  logger.info("Creating HTTP transport", { port: options.port, host: options.host });

  // Create MCP transport with session management
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: (): string => randomUUID(),
  });

  // Connect to MCP server
  // Use type assertion because StreamableHTTPServerTransport is compatible with Transport
  // but TypeScript's exactOptionalPropertyTypes causes issues with onclose handler
  await server.connect(transport as unknown as Transport);

  // Create middleware chain
  const middlewares: Middleware[] = [];

  // CORS middleware (if enabled)
  if (options.cors?.enabled) {
    middlewares.push(createCorsMiddleware(options.cors));
  }

  // Auth middleware (if required)
  if (options.requireAuth) {
    middlewares.push(createAuthMiddleware(options.auth));
  }

  // Rate limit middleware
  const { middleware: rateLimitMiddleware, rateLimiter } = createRateLimitMiddleware(
    options.rateLimit
  );
  middlewares.push(rateLimitMiddleware);

  const chain = chainMiddleware(middlewares);

  // Create HTTP server
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Health check endpoints
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
      return;
    }

    if (req.url === "/ready") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ready", timestamp: new Date().toISOString() }));
      return;
    }

    // Rate limiter stats endpoint (for debugging)
    if (req.url === "/stats" && req.method === "GET") {
      const stats = rateLimiter.getStats();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ stats, timestamp: new Date().toISOString() }));
      return;
    }

    // Apply middleware chain then handle MCP request
    chain(req, res, () => {
      // Handle MCP request
      transport.handleRequest(req, res).catch((error) => {
        logger.error("Error handling MCP request", { error });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    });
  });

  // Start listening
  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(options.port, options.host, () => {
      logger.info(`HTTP transport listening on http://${options.host}:${options.port}`);
      resolve();
    });
  });

  // Stop function
  const stop = async (): Promise<void> => {
    logger.info("Stopping HTTP transport");

    // Close transport first
    await transport.close();

    // Then close HTTP server
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Clean up rate limiter
    rateLimiter.destroy();

    logger.info("HTTP transport stopped");
  };

  return {
    server: httpServer,
    transport,
    rateLimiter,
    stop,
  };
}

/**
 * Start MCP server with HTTP transport
 *
 * This function sets up signal handlers and keeps the server running.
 */
export async function startHttpServer(
  server: MCPServer,
  options: HttpTransportOptions
): Promise<HttpTransport> {
  logger.info("Starting MCP server with HTTP transport");

  const httpTransport = await createHttpTransport(server, options);

  // Set up graceful shutdown
  const shutdown = async (): Promise<void> => {
    logger.info("Shutting down MCP server (HTTP)");
    await httpTransport.stop();
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

  logger.info(`MCP server running (HTTP mode) at http://${options.host}:${options.port}`);

  return httpTransport;
}
