/**
 * Tests for MCP hardening module (circuit breakers and watchdogs)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HardenedToolHandler,
  hardenToolHandler,
  getMCPCircuitStatus,
  resetAllMCPCircuits,
  isMCPHealthy,
  DEFAULT_MCP_HARDENING_CONFIG,
} from "../../src/mcp/hardening.js";
import type { MCPContext } from "../../src/mcp/types.js";
import { CircuitBreakerRegistry } from "../../src/infra/circuit-breaker.js";

describe("MCP Hardening", () => {
  const mockContext: MCPContext = {
    sendProgress: vi.fn(),
    isCancelled: () => false,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    // Reset all circuit breakers before each test
    resetAllMCPCircuits();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAllMCPCircuits();
  });

  describe("DEFAULT_MCP_HARDENING_CONFIG", () => {
    it("has reasonable default values", () => {
      expect(DEFAULT_MCP_HARDENING_CONFIG.circuitBreakerEnabled).toBe(true);
      expect(DEFAULT_MCP_HARDENING_CONFIG.watchdogEnabled).toBe(true);
      expect(DEFAULT_MCP_HARDENING_CONFIG.defaultTimeoutMs).toBe(300000);
      expect(DEFAULT_MCP_HARDENING_CONFIG.circuitBreaker.failureThreshold).toBe(3);
      expect(DEFAULT_MCP_HARDENING_CONFIG.circuitBreaker.successThreshold).toBe(2);
      expect(DEFAULT_MCP_HARDENING_CONFIG.circuitBreaker.openDurationMs).toBe(60000);
    });

    it("has per-tool timeout overrides", () => {
      expect(DEFAULT_MCP_HARDENING_CONFIG.toolTimeouts.work_on_issue).toBe(600000);
      expect(DEFAULT_MCP_HARDENING_CONFIG.toolTimeouts.iterate_on_feedback).toBe(300000);
      expect(DEFAULT_MCP_HARDENING_CONFIG.toolTimeouts.run_autonomous).toBe(1800000);
    });
  });

  describe("HardenedToolHandler", () => {
    it("executes handler successfully on first call", async () => {
      const mockHandler = vi.fn().mockResolvedValue({ success: true, data: { result: "ok" } });

      const hardened = new HardenedToolHandler("test_tool", mockHandler, {
        circuitBreakerEnabled: false,
        watchdogEnabled: false,
      });

      const result = await hardened.execute({}, mockContext);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ result: "ok" });
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("passes arguments and context to handler", async () => {
      const mockHandler = vi.fn().mockResolvedValue({ success: true });

      const hardened = new HardenedToolHandler("test_tool", mockHandler, {
        circuitBreakerEnabled: false,
        watchdogEnabled: false,
      });

      const args = { issueUrl: "https://github.com/test/repo/issues/1" };
      await hardened.execute(args, mockContext);

      expect(mockHandler).toHaveBeenCalledWith(args, mockContext);
    });

    it("returns error result on handler failure", async () => {
      const mockHandler = vi.fn().mockRejectedValue(new Error("Test failure"));

      const hardened = new HardenedToolHandler("test_tool", mockHandler, {
        circuitBreakerEnabled: false,
        watchdogEnabled: false,
      });

      const result = await hardened.execute({}, mockContext);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INTERNAL_ERROR");
      expect(result.error?.message).toContain("Test failure");
    });

    it("times out if handler takes too long", async () => {
      const slowHandler = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        return { success: true };
      });

      const hardened = new HardenedToolHandler("test_tool", slowHandler, {
        circuitBreakerEnabled: false,
        watchdogEnabled: false,
        defaultTimeoutMs: 100,
        toolTimeouts: {},
      });

      const resultPromise = hardened.execute({}, mockContext);

      // Advance timers past the timeout
      vi.advanceTimersByTime(150);

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("TIMEOUT");
    });

    describe("circuit breaker integration", () => {
      it("opens circuit after repeated failures", async () => {
        const failingHandler = vi.fn().mockRejectedValue(new Error("Failure"));

        const hardened = new HardenedToolHandler("circuit_test", failingHandler, {
          circuitBreakerEnabled: true,
          watchdogEnabled: false,
          circuitBreaker: {
            failureThreshold: 2,
            successThreshold: 1,
            openDurationMs: 60000,
          },
          defaultTimeoutMs: 10000,
          toolTimeouts: {},
        });

        // First failure
        await hardened.execute({}, mockContext);
        expect(hardened.getCircuitState()).toBe("closed");

        // Second failure - should open circuit
        await hardened.execute({}, mockContext);
        expect(hardened.getCircuitState()).toBe("open");
      });

      it("returns circuit open error when circuit is open", async () => {
        const failingHandler = vi.fn().mockRejectedValue(new Error("Failure"));

        const hardened = new HardenedToolHandler("circuit_test2", failingHandler, {
          circuitBreakerEnabled: true,
          watchdogEnabled: false,
          circuitBreaker: {
            failureThreshold: 1,
            successThreshold: 1,
            openDurationMs: 60000,
          },
          defaultTimeoutMs: 10000,
          toolTimeouts: {},
        });

        // Trip the circuit
        await hardened.execute({}, mockContext);
        expect(hardened.getCircuitState()).toBe("open");

        // Reset handler to track new calls
        failingHandler.mockClear();

        // Should fail fast without calling handler
        const result = await hardened.execute({}, mockContext);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("CIRCUIT_OPEN");
        expect(failingHandler).not.toHaveBeenCalled();
      });

      it("resets circuit after manual reset", async () => {
        const failingHandler = vi.fn().mockRejectedValue(new Error("Failure"));

        const hardened = new HardenedToolHandler("circuit_test3", failingHandler, {
          circuitBreakerEnabled: true,
          watchdogEnabled: false,
          circuitBreaker: {
            failureThreshold: 1,
            successThreshold: 1,
            openDurationMs: 60000,
          },
          defaultTimeoutMs: 10000,
          toolTimeouts: {},
        });

        // Trip the circuit
        await hardened.execute({}, mockContext);
        expect(hardened.getCircuitState()).toBe("open");

        // Reset
        hardened.resetCircuit();
        expect(hardened.getCircuitState()).toBe("closed");
      });
    });
  });

  describe("hardenToolHandler", () => {
    it("returns a wrapped handler function", async () => {
      const originalHandler = vi.fn().mockResolvedValue({ success: true, data: { test: true } });

      const hardenedHandler = hardenToolHandler("wrapped_test", originalHandler, {
        circuitBreakerEnabled: false,
        watchdogEnabled: false,
      });

      const result = await hardenedHandler({ arg: "value" }, mockContext);

      expect(result.success).toBe(true);
      expect(originalHandler).toHaveBeenCalledWith({ arg: "value" }, mockContext);
    });
  });

  describe("getMCPCircuitStatus", () => {
    it("returns status for MCP circuits only", () => {
      // Create some circuit breakers with different prefixes
      const registry = CircuitBreakerRegistry.getInstance();
      registry.get("mcp-status_test_1");
      registry.get("mcp-status_test_2");
      registry.get("non-mcp-status-tool"); // Should not be included

      const status = getMCPCircuitStatus();

      // Should only include MCP-prefixed breakers
      expect(status["mcp-status_test_1"]).toBeDefined();
      expect(status["mcp-status_test_2"]).toBeDefined();
      expect(status["non-mcp-status-tool"]).toBeUndefined();

      // Check structure of status entries
      expect(status["mcp-status_test_1"]).toHaveProperty("state");
      expect(status["mcp-status_test_1"]).toHaveProperty("failures");
      expect(status["mcp-status_test_1"]).toHaveProperty("reopenAt");
    });

    it("includes only MCP-prefixed circuit breakers", async () => {
      // Create some circuit breakers
      const registry = CircuitBreakerRegistry.getInstance();
      registry.get("mcp-filter_test_1");
      registry.get("mcp-filter_test_2");
      registry.get("non-mcp-filter-tool"); // Should not be included

      const status = getMCPCircuitStatus();

      expect(status["mcp-filter_test_1"]).toBeDefined();
      expect(status["mcp-filter_test_2"]).toBeDefined();
      expect(status["non-mcp-filter-tool"]).toBeUndefined();
    });
  });

  describe("isMCPHealthy", () => {
    it("returns true when all circuits are closed", () => {
      resetAllMCPCircuits();
      expect(isMCPHealthy()).toBe(true);
    });

    it("returns false when any circuit is open", async () => {
      const failingHandler = vi.fn().mockRejectedValue(new Error("Failure"));

      const hardened = new HardenedToolHandler("health_test", failingHandler, {
        circuitBreakerEnabled: true,
        watchdogEnabled: false,
        circuitBreaker: {
          failureThreshold: 1,
          successThreshold: 1,
          openDurationMs: 60000,
        },
        defaultTimeoutMs: 10000,
        toolTimeouts: {},
      });

      // Trip the circuit
      await hardened.execute({}, mockContext);

      expect(isMCPHealthy()).toBe(false);
    });
  });

  describe("resetAllMCPCircuits", () => {
    it("resets all MCP circuit breakers", async () => {
      const failingHandler = vi.fn().mockRejectedValue(new Error("Failure"));

      // Create and trip multiple circuits
      for (let i = 0; i < 3; i++) {
        const hardened = new HardenedToolHandler(`reset_test_${i}`, failingHandler, {
          circuitBreakerEnabled: true,
          watchdogEnabled: false,
          circuitBreaker: {
            failureThreshold: 1,
            successThreshold: 1,
            openDurationMs: 60000,
          },
          defaultTimeoutMs: 10000,
          toolTimeouts: {},
        });
        await hardened.execute({}, mockContext);
      }

      // All should be open
      expect(isMCPHealthy()).toBe(false);

      // Reset all
      resetAllMCPCircuits();

      // All should be closed now
      expect(isMCPHealthy()).toBe(true);
    });
  });
});
