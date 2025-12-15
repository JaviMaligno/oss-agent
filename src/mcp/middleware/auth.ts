/**
 * MCP Authentication Middleware
 *
 * Provides API key authentication for HTTP transport.
 * Implements simple bearer token validation for MCP requests.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../../infra/logger.js";
import { readFileSync, existsSync } from "node:fs";
import { expandPath } from "../../cli/config/loader.js";

/**
 * Auth configuration
 */
export interface AuthConfig {
  /** List of valid API keys */
  apiKeys: string[];
  /** Path to file containing API keys (one per line) */
  apiKeysFile: string | undefined;
  /** Whether authentication is required (default: true for HTTP) */
  required: boolean | undefined;
}

/**
 * Auth info attached to requests (our custom type)
 */
export interface MCPAuthInfo {
  /** The authenticated API key (masked) */
  apiKey: string;
  /** When the key was validated */
  validatedAt: Date;
  /** Client IP address */
  clientIp: string | undefined;
}

// Store auth info per request using WeakMap to avoid extending IncomingMessage
// (which conflicts with MCP SDK's own auth types)
const requestAuthInfo = new WeakMap<IncomingMessage, MCPAuthInfo>();

/**
 * Get auth info for a request
 */
export function getAuthInfo(req: IncomingMessage): MCPAuthInfo | undefined {
  return requestAuthInfo.get(req);
}

/**
 * Set auth info for a request
 */
export function setAuthInfo(req: IncomingMessage, auth: MCPAuthInfo): void {
  requestAuthInfo.set(req, auth);
}

/**
 * Load API keys from configuration
 */
export function loadApiKeys(config: AuthConfig): Set<string> {
  const keys = new Set<string>();

  // Add keys from config array
  for (const key of config.apiKeys) {
    if (key.trim()) {
      keys.add(key.trim());
    }
  }

  // Load keys from file if specified
  if (config.apiKeysFile) {
    const filePath = expandPath(config.apiKeysFile);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const fileKeys = content
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"));

        for (const key of fileKeys) {
          keys.add(key);
        }

        logger.debug(`Loaded ${fileKeys.length} API keys from ${filePath}`);
      } catch (error) {
        logger.warn(`Failed to load API keys from ${filePath}: ${error}`);
      }
    } else {
      logger.warn(`API keys file not found: ${filePath}`);
    }
  }

  return keys;
}

/**
 * Mask API key for logging
 */
function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return "***";
  }
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * Extract client IP from request
 */
function getClientIp(req: IncomingMessage): string | undefined {
  // Check X-Forwarded-For header (for proxied requests)
  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) {
    const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor.split(",")[0];
    return ips?.trim();
  }

  // Check X-Real-IP header
  const realIp = req.headers["x-real-ip"];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }

  // Fall back to socket remote address
  return req.socket.remoteAddress;
}

/**
 * API Key authentication middleware
 *
 * Validates Bearer token in Authorization header against configured API keys.
 */
export function createAuthMiddleware(
  config: AuthConfig
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const validKeys = loadApiKeys(config);
  const isRequired = config.required ?? true;

  if (validKeys.size === 0 && isRequired) {
    logger.warn("No API keys configured for HTTP transport - all requests will be rejected");
  }

  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    // Skip auth for health check endpoints
    if (req.url === "/health" || req.url === "/ready") {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    const clientIp = getClientIp(req);

    // No auth header provided
    if (!authHeader) {
      if (!isRequired) {
        // Auth not required, allow through without auth info
        next();
        return;
      }

      logger.warn("Missing Authorization header", { clientIp, url: req.url });
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="MCP Server"',
      });
      res.end(JSON.stringify({ error: "Missing Authorization header" }));
      return;
    }

    // Parse Authorization header
    const [type, token] = authHeader.split(" ");
    if (type?.toLowerCase() !== "bearer" || !token) {
      logger.warn("Invalid Authorization header format", { clientIp, url: req.url });
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="MCP Server"',
      });
      res.end(
        JSON.stringify({ error: "Invalid Authorization header format, expected 'Bearer TOKEN'" })
      );
      return;
    }

    // Validate token
    if (!validKeys.has(token)) {
      logger.warn("Invalid API key", { clientIp, url: req.url, key: maskApiKey(token) });
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="MCP Server"',
      });
      res.end(JSON.stringify({ error: "Invalid API key" }));
      return;
    }

    // Store auth info using WeakMap
    setAuthInfo(req, {
      apiKey: maskApiKey(token),
      validatedAt: new Date(),
      clientIp,
    });

    logger.debug("Request authenticated", { clientIp, key: maskApiKey(token) });
    next();
  };
}

/**
 * Simple in-memory API key store
 * Can be extended to support database-backed storage
 */
export class ApiKeyStore {
  private keys: Set<string>;
  private readonly config: AuthConfig;

  constructor(config: AuthConfig) {
    this.config = config;
    this.keys = loadApiKeys(config);
  }

  /**
   * Check if a key is valid
   */
  isValid(key: string): boolean {
    return this.keys.has(key);
  }

  /**
   * Add a new key
   */
  addKey(key: string): void {
    this.keys.add(key);
    logger.info("API key added", { key: maskApiKey(key) });
  }

  /**
   * Remove a key
   */
  removeKey(key: string): boolean {
    const removed = this.keys.delete(key);
    if (removed) {
      logger.info("API key removed", { key: maskApiKey(key) });
    }
    return removed;
  }

  /**
   * Reload keys from configuration
   */
  reload(): void {
    this.keys = loadApiKeys(this.config);
    logger.info("API keys reloaded", { count: this.keys.size });
  }

  /**
   * Get count of configured keys
   */
  get count(): number {
    return this.keys.size;
  }
}
