import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  getCircuitBreaker,
  CIRCUIT_OPERATIONS,
} from "../../src/infra/circuit-breaker.js";
import { CircuitOpenError } from "../../src/infra/errors.js";

describe("CircuitBreaker", () => {
  describe("initial state", () => {
    it("should start in closed state", () => {
      const cb = new CircuitBreaker("test");
      expect(cb.getState()).toBe("closed");
      expect(cb.getFailureCount()).toBe(0);
    });
  });

  describe("closed state", () => {
    it("should pass through successful operations", async () => {
      const cb = new CircuitBreaker("test");
      const result = await cb.execute(() => Promise.resolve("success"));
      expect(result).toBe("success");
      expect(cb.getState()).toBe("closed");
    });

    it("should count failures", async () => {
      const cb = new CircuitBreaker("test", { failureThreshold: 5 });

      await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");

      expect(cb.getFailureCount()).toBe(1);
      expect(cb.getState()).toBe("closed");
    });

    it("should reset failure count on success", async () => {
      const cb = new CircuitBreaker("test", { failureThreshold: 5 });

      // Accumulate some failures
      await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
      await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
      expect(cb.getFailureCount()).toBe(2);

      // Success resets count
      await cb.execute(() => Promise.resolve("success"));
      expect(cb.getFailureCount()).toBe(0);
    });

    it("should transition to open after threshold failures", async () => {
      const cb = new CircuitBreaker("test", { failureThreshold: 3 });

      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
      }

      expect(cb.getState()).toBe("open");
    });
  });

  describe("open state", () => {
    it("should reject immediately with CircuitOpenError", async () => {
      const cb = new CircuitBreaker("test", { failureThreshold: 1, openDurationMs: 10000 });

      // Trip the circuit
      await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();

      // Should reject immediately
      await expect(cb.execute(() => Promise.resolve("success"))).rejects.toThrow(CircuitOpenError);
    });

    it("should provide reopen time in error", async () => {
      const cb = new CircuitBreaker("test", { failureThreshold: 1, openDurationMs: 1000 });

      await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();

      try {
        await cb.execute(() => Promise.resolve("success"));
      } catch (error) {
        expect(error).toBeInstanceOf(CircuitOpenError);
        const circuitError = error as CircuitOpenError;
        expect(circuitError.reopenAt).toBeInstanceOf(Date);
        expect(circuitError.operationType).toBe("test");
      }
    });

    it("should transition to half-open after openDurationMs", async () => {
      vi.useFakeTimers();

      const cb = new CircuitBreaker("test", { failureThreshold: 1, openDurationMs: 100 });

      // Trip the circuit
      await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
      expect(cb.getState()).toBe("open");

      // Advance time past openDuration
      vi.advanceTimersByTime(150);

      // getState() should now return half-open
      expect(cb.getState()).toBe("half-open");

      vi.useRealTimers();
    });
  });

  describe("half-open state", () => {
    it("should transition to closed after successThreshold successes", async () => {
      vi.useFakeTimers();

      const cb = new CircuitBreaker("test", {
        failureThreshold: 1,
        successThreshold: 2,
        openDurationMs: 100,
      });

      // Trip the circuit
      await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
      expect(cb.getState()).toBe("open");

      // Advance to half-open
      vi.advanceTimersByTime(150);
      expect(cb.getState()).toBe("half-open");

      // First success
      await cb.execute(() => Promise.resolve("success"));
      expect(cb.getState()).toBe("half-open");

      // Second success closes circuit
      await cb.execute(() => Promise.resolve("success"));
      expect(cb.getState()).toBe("closed");

      vi.useRealTimers();
    });

    it("should transition back to open on any failure", async () => {
      vi.useFakeTimers();

      const cb = new CircuitBreaker("test", {
        failureThreshold: 1,
        successThreshold: 2,
        openDurationMs: 100,
      });

      // Trip the circuit
      await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();

      // Advance to half-open
      vi.advanceTimersByTime(150);
      expect(cb.getState()).toBe("half-open");

      // Failure in half-open goes back to open
      await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
      expect(cb.getState()).toBe("open");

      vi.useRealTimers();
    });
  });

  describe("manual controls", () => {
    it("should reset to closed state", async () => {
      const cb = new CircuitBreaker("test", { failureThreshold: 1 });

      // Trip the circuit
      await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
      expect(cb.getState()).toBe("open");

      // Reset
      cb.reset();
      expect(cb.getState()).toBe("closed");
      expect(cb.getFailureCount()).toBe(0);
    });

    it("should manually trip the circuit", () => {
      const cb = new CircuitBreaker("test");

      expect(cb.getState()).toBe("closed");
      cb.trip();
      expect(cb.getState()).toBe("open");
    });
  });

  describe("callbacks", () => {
    it("should call onStateChange callback", async () => {
      const onStateChange = vi.fn();
      const cb = new CircuitBreaker("test", {
        failureThreshold: 1,
        onStateChange,
      });

      await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();

      expect(onStateChange).toHaveBeenCalledWith("closed", "open", "test");
    });
  });

  describe("getters", () => {
    it("should return last failure time", async () => {
      const cb = new CircuitBreaker("test", { failureThreshold: 5 });

      expect(cb.getLastFailureTime()).toBeUndefined();

      await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();

      expect(cb.getLastFailureTime()).toBeInstanceOf(Date);
    });

    it("should return reopen time when open", async () => {
      const cb = new CircuitBreaker("test", { failureThreshold: 1, openDurationMs: 1000 });

      expect(cb.getReopenTime()).toBeUndefined();

      await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();

      expect(cb.getReopenTime()).toBeInstanceOf(Date);
    });
  });
});

describe("CircuitBreakerRegistry", () => {
  beforeEach(() => {
    // Reset registry state - note that circuit breakers are cached by name,
    // so we need to use unique names per test
    const registry = CircuitBreakerRegistry.getInstance();
    registry.resetAll();
  });

  it("should be a singleton", () => {
    const r1 = CircuitBreakerRegistry.getInstance();
    const r2 = CircuitBreakerRegistry.getInstance();
    expect(r1).toBe(r2);
  });

  it("should create and cache circuit breakers", () => {
    const registry = CircuitBreakerRegistry.getInstance();

    const cb1 = registry.get("test-op-cache");
    const cb2 = registry.get("test-op-cache");

    expect(cb1).toBe(cb2);
  });

  it("should reset all circuit breakers to closed state", async () => {
    const registry = CircuitBreakerRegistry.getInstance();

    // Use unique name for this test
    const cb = registry.get("test-op-reset", { failureThreshold: 1 });
    await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    expect(cb.getState()).toBe("open");

    registry.resetAll();

    // After resetAll, the circuit should be closed
    expect(cb.getState()).toBe("closed");
  });

  it("should return status of all circuit breakers", async () => {
    const registry = CircuitBreakerRegistry.getInstance();

    // Use unique names for this test
    registry.get("status-op1");
    const cb2 = registry.get("status-op2", { failureThreshold: 1 });
    await expect(cb2.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();

    const status = registry.getStatus();

    expect(status["status-op1"]).toBeDefined();
    expect(status["status-op1"]!.state).toBe("closed");
    expect(status["status-op2"]).toBeDefined();
    expect(status["status-op2"]!.state).toBe("open");
  });

  it("should get all registered circuit breakers", () => {
    const registry = CircuitBreakerRegistry.getInstance();

    registry.get("getall-op1");
    registry.get("getall-op2");

    const all = registry.getAll();

    expect(all.has("getall-op1")).toBe(true);
    expect(all.has("getall-op2")).toBe(true);
  });
});

describe("getCircuitBreaker", () => {
  it("should be a convenience wrapper for registry.get", () => {
    const cb = getCircuitBreaker("convenience-test");
    const registry = CircuitBreakerRegistry.getInstance();
    const cb2 = registry.get("convenience-test");

    expect(cb).toBe(cb2);
  });
});

describe("CIRCUIT_OPERATIONS", () => {
  it("should have predefined operation types", () => {
    expect(CIRCUIT_OPERATIONS.AI_PROVIDER).toBe("ai-provider");
    expect(CIRCUIT_OPERATIONS.GITHUB_API).toBe("github-api");
    expect(CIRCUIT_OPERATIONS.GIT_OPERATIONS).toBe("git-operations");
  });
});
