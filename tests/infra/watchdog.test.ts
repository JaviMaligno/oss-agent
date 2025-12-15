import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Watchdog,
  createAIOperationWatchdog,
  createGitOperationWatchdog,
  withWatchdog,
} from "../../src/infra/watchdog.js";

describe("Watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic functionality", () => {
    it("should start and track running state", () => {
      const onTimeout = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 1000, onTimeout });

      expect(watchdog.isRunning()).toBe(false);

      watchdog.start();

      expect(watchdog.isRunning()).toBe(true);
    });

    it("should stop and clear running state", () => {
      const onTimeout = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 1000, onTimeout });

      watchdog.start();
      expect(watchdog.isRunning()).toBe(true);

      watchdog.stop();
      expect(watchdog.isRunning()).toBe(false);
    });

    it("should call onTimeout when timeout expires", () => {
      const onTimeout = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 1000, onTimeout });

      watchdog.start();
      vi.advanceTimersByTime(1000);

      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith(
        expect.objectContaining({
          operationType: "test",
          startedAt: expect.any(Date),
          lastHeartbeat: expect.any(Date),
        })
      );
    });

    it("should not call onTimeout if stopped before expiry", () => {
      const onTimeout = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 1000, onTimeout });

      watchdog.start();
      vi.advanceTimersByTime(500);
      watchdog.stop();
      vi.advanceTimersByTime(1000);

      expect(onTimeout).not.toHaveBeenCalled();
    });
  });

  describe("heartbeat", () => {
    it("should reset timeout on heartbeat", () => {
      const onTimeout = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 1000, onTimeout });

      watchdog.start();

      // Advance 800ms
      vi.advanceTimersByTime(800);
      watchdog.heartbeat();

      // Advance another 800ms (would have timed out without heartbeat)
      vi.advanceTimersByTime(800);
      expect(onTimeout).not.toHaveBeenCalled();

      // Complete the timeout
      vi.advanceTimersByTime(200);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it("should update lastHeartbeat time", () => {
      const onTimeout = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 1000, onTimeout });

      watchdog.start();

      const initialContext = watchdog.getContext();
      vi.advanceTimersByTime(500);
      watchdog.heartbeat();

      const updatedContext = watchdog.getContext();
      expect(updatedContext!.lastHeartbeat.getTime()).toBeGreaterThan(
        initialContext!.lastHeartbeat.getTime()
      );
    });

    it("should call onHeartbeat callback", () => {
      const onTimeout = vi.fn();
      const onHeartbeat = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 1000, onTimeout, onHeartbeat });

      watchdog.start();
      watchdog.heartbeat();

      expect(onHeartbeat).toHaveBeenCalledTimes(1);
      expect(onHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          operationType: "test",
        })
      );
    });

    it("should ignore heartbeat when not running", () => {
      const onTimeout = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 1000, onTimeout });

      // Heartbeat before start should be ignored
      watchdog.heartbeat();

      expect(watchdog.isRunning()).toBe(false);
    });
  });

  describe("timing methods", () => {
    it("should track elapsed time", () => {
      const onTimeout = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 10000, onTimeout });

      watchdog.start();
      expect(watchdog.getElapsedMs()).toBe(0);

      vi.advanceTimersByTime(500);
      expect(watchdog.getElapsedMs()).toBe(500);
    });

    it("should track time since heartbeat", () => {
      const onTimeout = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 10000, onTimeout });

      watchdog.start();
      vi.advanceTimersByTime(300);
      watchdog.heartbeat();

      vi.advanceTimersByTime(200);
      expect(watchdog.getTimeSinceHeartbeatMs()).toBe(200);
    });

    it("should return 0 for timing methods when not running", () => {
      const onTimeout = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 1000, onTimeout });

      expect(watchdog.getElapsedMs()).toBe(0);
      expect(watchdog.getTimeSinceHeartbeatMs()).toBe(0);
    });
  });

  describe("context", () => {
    it("should include metadata in context", () => {
      const onTimeout = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 1000, onTimeout });

      watchdog.start({ query: "test prompt", model: "claude-3" });

      const context = watchdog.getContext();
      expect(context?.metadata).toEqual({ query: "test prompt", model: "claude-3" });
    });

    it("should return undefined context when not running", () => {
      const onTimeout = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 1000, onTimeout });

      expect(watchdog.getContext()).toBeUndefined();
    });

    it("should pass context to onTimeout", () => {
      const onTimeout = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 1000, onTimeout });

      watchdog.start({ key: "value" });
      vi.advanceTimersByTime(1000);

      expect(onTimeout).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { key: "value" },
        })
      );
    });
  });

  describe("restart behavior", () => {
    it("should reset when started while already running", () => {
      const onTimeout = vi.fn();
      const watchdog = new Watchdog("test", { timeoutMs: 1000, onTimeout });

      watchdog.start({ first: true });
      vi.advanceTimersByTime(800);

      // Restart with new metadata
      watchdog.start({ second: true });

      // The old timer should be cleared
      vi.advanceTimersByTime(800);
      expect(onTimeout).not.toHaveBeenCalled();

      // New timer should fire at new 1000ms mark
      vi.advanceTimersByTime(200);
      expect(onTimeout).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { second: true },
        })
      );
    });
  });
});

describe("createAIOperationWatchdog", () => {
  it("should create watchdog with default timeout", () => {
    vi.useFakeTimers();

    const onTimeout = vi.fn();
    const watchdog = createAIOperationWatchdog(onTimeout);

    watchdog.start();
    vi.advanceTimersByTime(300000); // 5 minutes default

    expect(onTimeout).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("should accept custom timeout", () => {
    vi.useFakeTimers();

    const onTimeout = vi.fn();
    const watchdog = createAIOperationWatchdog(onTimeout, 1000);

    watchdog.start();
    vi.advanceTimersByTime(1000);

    expect(onTimeout).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

describe("createGitOperationWatchdog", () => {
  it("should create watchdog with default timeout", () => {
    vi.useFakeTimers();

    const onTimeout = vi.fn();
    const watchdog = createGitOperationWatchdog(onTimeout);

    watchdog.start();
    vi.advanceTimersByTime(60000); // 1 minute default

    expect(onTimeout).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

describe("withWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should automatically manage watchdog lifecycle", async () => {
    const onTimeout = vi.fn();

    const result = await withWatchdog(
      "test",
      async () => {
        return "result";
      },
      { timeoutMs: 1000, onTimeout }
    );

    expect(result).toBe("result");
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("should provide heartbeat callback", async () => {
    const onTimeout = vi.fn();
    let heartbeatCount = 0;

    await withWatchdog(
      "test",
      async (heartbeat) => {
        heartbeat();
        heartbeatCount++;
        heartbeat();
        heartbeatCount++;
        return "done";
      },
      { timeoutMs: 1000, onTimeout }
    );

    expect(heartbeatCount).toBe(2);
  });

  it("should stop watchdog even if function throws", async () => {
    const onTimeout = vi.fn();

    await expect(
      withWatchdog(
        "test",
        async () => {
          throw new Error("function error");
        },
        { timeoutMs: 1000, onTimeout }
      )
    ).rejects.toThrow("function error");

    // Advance time past timeout - should not fire since watchdog was stopped
    vi.advanceTimersByTime(2000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
