/**
 * MCP Rate Limiting Middleware
 *
 * Provides request throttling for the HTTP transport.
 * Implements a sliding window rate limiter with per-client tracking.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../../infra/logger.js";

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Whether rate limiting is enabled */
  enabled: boolean;
  /** Maximum requests per minute per client */
  maxRequestsPerMinute: number;
  /** Maximum concurrent operations */
  maxConcurrentOps: number;
  /** Window size in milliseconds (default: 60000 = 1 minute) */
  windowMs?: number;
  /** Custom key extractor (default: uses client IP) */
  keyExtractor?: (req: IncomingMessage) => string;
}

/**
 * Rate limit info for a client
 */
interface ClientRateInfo {
  /** Timestamps of recent requests */
  requests: number[];
  /** Number of currently active operations */
  activeOps: number;
  /** When the client was first seen */
  firstSeen: Date;
}

/**
 * Rate limit result
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Current request count in window */
  current: number;
  /** Maximum allowed in window */
  limit: number;
  /** Remaining requests in window */
  remaining: number;
  /** Time until window resets (ms) */
  resetIn: number;
  /** Retry after (seconds, if rate limited) */
  retryAfter?: number;
  /** Reason if blocked */
  reason?: string;
}

/**
 * Extract client identifier from request
 */
function defaultKeyExtractor(req: IncomingMessage): string {
  // Check X-Forwarded-For header (for proxied requests)
  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) {
    const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor.split(",")[0];
    if (ips?.trim()) {
      return ips.trim();
    }
  }

  // Check X-Real-IP header
  const realIp = req.headers["x-real-ip"];
  if (realIp) {
    return Array.isArray(realIp) ? (realIp[0] ?? "unknown") : realIp;
  }

  // Fall back to socket remote address
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Rate limiter implementation using sliding window algorithm
 */
export class RateLimiter {
  private clients: Map<string, ClientRateInfo> = new Map();
  private readonly config: RateLimitConfig;
  private readonly windowMs: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: RateLimitConfig) {
    this.config = config;
    this.windowMs = config.windowMs ?? 60000; // Default 1 minute

    // Start cleanup interval to prevent memory leaks
    this.cleanupInterval = setInterval(() => this.cleanup(), this.windowMs * 2);
  }

  /**
   * Check if a request should be allowed
   */
  check(clientKey: string): RateLimitResult {
    if (!this.config.enabled) {
      return {
        allowed: true,
        current: 0,
        limit: this.config.maxRequestsPerMinute,
        remaining: this.config.maxRequestsPerMinute,
        resetIn: 0,
      };
    }

    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Get or create client info
    let clientInfo = this.clients.get(clientKey);
    if (!clientInfo) {
      clientInfo = {
        requests: [],
        activeOps: 0,
        firstSeen: new Date(),
      };
      this.clients.set(clientKey, clientInfo);
    }

    // Remove old requests outside the window
    clientInfo.requests = clientInfo.requests.filter((ts) => ts > windowStart);

    // Check rate limit
    const current = clientInfo.requests.length;
    const limit = this.config.maxRequestsPerMinute;
    const remaining = Math.max(0, limit - current);

    // Calculate reset time (when the oldest request in window expires)
    const oldestInWindow = clientInfo.requests[0] ?? now;
    const resetIn = Math.max(0, oldestInWindow + this.windowMs - now);

    if (current >= limit) {
      const retryAfter = Math.ceil(resetIn / 1000);
      logger.warn("Rate limit exceeded", { clientKey, current, limit, retryAfter });
      return {
        allowed: false,
        current,
        limit,
        remaining: 0,
        resetIn,
        retryAfter,
        reason: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
      };
    }

    // Check concurrent operations limit
    if (clientInfo.activeOps >= this.config.maxConcurrentOps) {
      logger.warn("Concurrent operations limit exceeded", {
        clientKey,
        activeOps: clientInfo.activeOps,
        maxConcurrentOps: this.config.maxConcurrentOps,
      });
      return {
        allowed: false,
        current,
        limit,
        remaining,
        resetIn,
        retryAfter: 5, // Suggest retry in 5 seconds
        reason: `Maximum concurrent operations (${this.config.maxConcurrentOps}) exceeded. Try again shortly.`,
      };
    }

    return {
      allowed: true,
      current,
      limit,
      remaining,
      resetIn,
    };
  }

  /**
   * Record a request (call after check returns allowed: true)
   */
  recordRequest(clientKey: string): void {
    const clientInfo = this.clients.get(clientKey);
    if (clientInfo) {
      clientInfo.requests.push(Date.now());
    }
  }

  /**
   * Start tracking a long-running operation
   */
  startOperation(clientKey: string): void {
    const clientInfo = this.clients.get(clientKey);
    if (clientInfo) {
      clientInfo.activeOps++;
    }
  }

  /**
   * End tracking a long-running operation
   */
  endOperation(clientKey: string): void {
    const clientInfo = this.clients.get(clientKey);
    if (clientInfo && clientInfo.activeOps > 0) {
      clientInfo.activeOps--;
    }
  }

  /**
   * Get current active operations for a client
   */
  getActiveOps(clientKey: string): number {
    return this.clients.get(clientKey)?.activeOps ?? 0;
  }

  /**
   * Clean up old entries to prevent memory leaks
   */
  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    for (const [key, info] of this.clients) {
      // Remove old requests
      info.requests = info.requests.filter((ts) => ts > windowStart);

      // Remove clients with no recent activity and no active ops
      if (info.requests.length === 0 && info.activeOps === 0) {
        this.clients.delete(key);
      }
    }
  }

  /**
   * Stop the cleanup interval
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.clients.clear();
  }

  /**
   * Get statistics about rate limiting
   */
  getStats(): {
    totalClients: number;
    totalActiveOps: number;
    clientStats: Array<{ key: string; requests: number; activeOps: number }>;
  } {
    const clientStats = Array.from(this.clients.entries()).map(([key, info]) => ({
      key,
      requests: info.requests.length,
      activeOps: info.activeOps,
    }));

    return {
      totalClients: this.clients.size,
      totalActiveOps: clientStats.reduce((sum, c) => sum + c.activeOps, 0),
      clientStats,
    };
  }
}

/**
 * Create rate limiting middleware
 */
export function createRateLimitMiddleware(config: RateLimitConfig): {
  middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  rateLimiter: RateLimiter;
} {
  const rateLimiter = new RateLimiter(config);
  const keyExtractor = config.keyExtractor ?? defaultKeyExtractor;

  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    // Skip rate limiting for health check endpoints
    if (req.url === "/health" || req.url === "/ready") {
      next();
      return;
    }

    const clientKey = keyExtractor(req);
    const result = rateLimiter.check(clientKey);

    // Add rate limit headers
    res.setHeader("X-RateLimit-Limit", result.limit.toString());
    res.setHeader("X-RateLimit-Remaining", result.remaining.toString());
    res.setHeader("X-RateLimit-Reset", Math.ceil((Date.now() + result.resetIn) / 1000).toString());

    if (!result.allowed) {
      res.setHeader("Retry-After", (result.retryAfter ?? 60).toString());
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Too Many Requests",
          message: result.reason,
          retryAfter: result.retryAfter,
        })
      );
      return;
    }

    // Record the request
    rateLimiter.recordRequest(clientKey);

    // Attach rate limiter to request for operation tracking
    (req as IncomingMessage & { rateLimiter?: RateLimiter; rateLimitKey?: string }).rateLimiter =
      rateLimiter;
    (req as IncomingMessage & { rateLimiter?: RateLimiter; rateLimitKey?: string }).rateLimitKey =
      clientKey;

    next();
  };

  return { middleware, rateLimiter };
}
