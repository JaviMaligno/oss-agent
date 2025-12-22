import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ClaudeSDKProvider } from "../../src/core/ai/claude-sdk-provider.js";
import type { AIConfig, HardeningConfig } from "../../src/types/config.js";

/**
 * Tests for ClaudeSDKProvider session caching functionality.
 * These tests don't require an API key as they test the caching logic directly.
 */
describe("ClaudeSDKProvider Session Caching", () => {
  let provider: ClaudeSDKProvider;
  const mockConfig: AIConfig = {
    executionMode: "sdk",
    model: "claude-sonnet-4-20250514",
    cli: {
      maxTurns: 10,
    },
  };
  const mockDataDir = "/tmp/test-data";
  const mockHardening: HardeningConfig = {
    retry: {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      enableJitter: true,
    },
    circuitBreaker: {
      failureThreshold: 3,
      successThreshold: 2,
      openDurationMs: 30000,
    },
    watchdog: {
      aiOperationTimeoutMs: 300000,
      gitOperationTimeoutMs: 30000,
      networkTimeoutMs: 60000,
    },
    gracefulShutdown: {
      enabled: true,
      timeoutMs: 30000,
    },
    resourceLimits: {
      maxMemoryMb: 2048,
      maxCpuPercent: 80,
      checkIntervalMs: 5000,
    },
    healthCheck: {
      enabled: true,
      intervalMs: 30000,
    },
  };

  beforeEach(() => {
    provider = new ClaudeSDKProvider(mockConfig, mockDataDir, mockHardening);
  });

  afterEach(() => {
    provider.clearSessionCache();
  });

  describe("getCachedSession", () => {
    it("returns undefined when cache is empty", () => {
      const result = provider.getCachedSession("/some/path");
      expect(result).toBeUndefined();
    });

    it("returns undefined for non-existent path", () => {
      provider.cacheSession("/path/a", "session-123");
      const result = provider.getCachedSession("/path/b");
      expect(result).toBeUndefined();
    });

    it("returns cached session for existing path", () => {
      provider.cacheSession("/path/to/repo", "session-abc");
      const result = provider.getCachedSession("/path/to/repo");
      expect(result).toBe("session-abc");
    });
  });

  describe("cacheSession", () => {
    it("caches a new session", () => {
      provider.cacheSession("/path/to/repo", "new-session-id");

      const stats = provider.getSessionCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.entries[0]?.cwd).toBe("/path/to/repo");
      expect(stats.entries[0]?.queryCount).toBe(1);
    });

    it("updates existing session with new ID", () => {
      provider.cacheSession("/path/to/repo", "session-1");
      provider.cacheSession("/path/to/repo", "session-2");

      const result = provider.getCachedSession("/path/to/repo");
      expect(result).toBe("session-2");

      const stats = provider.getSessionCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.entries[0]?.queryCount).toBe(2);
    });

    it("handles multiple different paths", () => {
      provider.cacheSession("/path/a", "session-a");
      provider.cacheSession("/path/b", "session-b");
      provider.cacheSession("/path/c", "session-c");

      expect(provider.getCachedSession("/path/a")).toBe("session-a");
      expect(provider.getCachedSession("/path/b")).toBe("session-b");
      expect(provider.getCachedSession("/path/c")).toBe("session-c");

      const stats = provider.getSessionCacheStats();
      expect(stats.size).toBe(3);
    });
  });

  describe("clearSessionCache", () => {
    it("clears all cached sessions", () => {
      provider.cacheSession("/path/a", "session-a");
      provider.cacheSession("/path/b", "session-b");

      provider.clearSessionCache();

      expect(provider.getCachedSession("/path/a")).toBeUndefined();
      expect(provider.getCachedSession("/path/b")).toBeUndefined();
      expect(provider.getSessionCacheStats().size).toBe(0);
    });
  });

  describe("session expiration", () => {
    it("expires sessions after TTL", () => {
      // Set a very short TTL for testing
      provider.setSessionCacheTtl(100); // 100ms

      provider.cacheSession("/path/to/repo", "session-123");
      expect(provider.getCachedSession("/path/to/repo")).toBe("session-123");

      // Wait for TTL to expire
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(provider.getCachedSession("/path/to/repo")).toBeUndefined();
          resolve();
        }, 150);
      });
    });

    it("refreshes TTL on session update", () => {
      provider.setSessionCacheTtl(200); // 200ms

      provider.cacheSession("/path/to/repo", "session-1");

      // Wait 100ms, then update
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          provider.cacheSession("/path/to/repo", "session-2");

          // After another 150ms, session should still be valid (updated 150ms ago)
          setTimeout(() => {
            expect(provider.getCachedSession("/path/to/repo")).toBe("session-2");
            resolve();
          }, 150);
        }, 100);
      });
    });
  });

  describe("getSessionCacheStats", () => {
    it("returns empty stats for empty cache", () => {
      const stats = provider.getSessionCacheStats();
      expect(stats.size).toBe(0);
      expect(stats.entries).toHaveLength(0);
    });

    it("tracks query count correctly", () => {
      provider.cacheSession("/path/a", "session-1");
      provider.cacheSession("/path/a", "session-2");
      provider.cacheSession("/path/a", "session-3");

      const stats = provider.getSessionCacheStats();
      expect(stats.entries[0]?.queryCount).toBe(3);
    });

    it("tracks age correctly", () => {
      provider.cacheSession("/path/a", "session-1");

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const stats = provider.getSessionCacheStats();
          expect(stats.entries[0]?.ageMs).toBeGreaterThanOrEqual(50);
          resolve();
        }, 50);
      });
    });
  });

  describe("provider capabilities", () => {
    it("reports correct capabilities", () => {
      expect(provider.capabilities.sessionResume).toBe(true);
      expect(provider.capabilities.costTracking).toBe(true);
      expect(provider.capabilities.streaming).toBe(true);
      expect(provider.capabilities.budgetLimits).toBe(true);
      expect(provider.capabilities.customMcpServers).toBe(true);
    });

    it("has correct name", () => {
      expect(provider.name).toBe("claude-sdk");
    });
  });

  describe("isAvailable", () => {
    it("returns false without API key", async () => {
      // Remove API key from environment for this test
      const originalKey = process.env["ANTHROPIC_API_KEY"];
      delete process.env["ANTHROPIC_API_KEY"];

      const provider = new ClaudeSDKProvider(mockConfig, mockDataDir, mockHardening);
      const available = await provider.isAvailable();

      // Restore
      if (originalKey) {
        process.env["ANTHROPIC_API_KEY"] = originalKey;
      }

      expect(available).toBe(false);
    });

    it("returns true with API key in config", async () => {
      const configWithKey: AIConfig = {
        ...mockConfig,
        apiKey: "sk-ant-test-key",
      };

      const provider = new ClaudeSDKProvider(configWithKey, mockDataDir, mockHardening);
      const available = await provider.isAvailable();

      expect(available).toBe(true);
    });
  });

  describe("getUsage", () => {
    it("returns initial zero usage", () => {
      const usage = provider.getUsage();

      expect(usage.totalQueries).toBe(0);
      expect(usage.totalCostUsd).toBe(0);
      expect(usage.totalTurns).toBe(0);
      expect(usage.queriesToday).toBe(0);
      expect(usage.costTodayUsd).toBe(0);
    });

    it("returns a copy of usage data", () => {
      const usage1 = provider.getUsage();
      const usage2 = provider.getUsage();

      expect(usage1).not.toBe(usage2);
      expect(usage1).toEqual(usage2);
    });
  });

  describe("getDataDir", () => {
    it("returns the configured data directory", () => {
      expect(provider.getDataDir()).toBe(mockDataDir);
    });
  });
});
