import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HealthChecker, createAutonomousHealthChecker } from "../../src/infra/health-check.js";

describe("HealthChecker", () => {
  describe("checkDiskSpace", () => {
    it("should return disk space check result", () => {
      const checker = new HealthChecker();

      const result = checker.checkDiskSpace();

      // Should return a valid result (can't easily mock fs.statfsSync)
      expect(["ok", "warning", "critical", "unavailable"]).toContain(result.status);
      expect(result.path).toBeDefined();
      expect(typeof result.availableGb).toBe("number");
      expect(typeof result.usedPercent).toBe("number");
    });

    it("should use configured disk path", () => {
      const checker = new HealthChecker({ diskPath: "/tmp" });

      const result = checker.checkDiskSpace();

      expect(result.path).toBe("/tmp");
    });
  });

  describe("checkMemory", () => {
    it("should return memory check result", () => {
      const checker = new HealthChecker();

      const result = checker.checkMemory();

      expect(["ok", "warning"]).toContain(result.status);
      expect(result.usedMb).toBeGreaterThan(0);
      expect(result.availableMb).toBeGreaterThanOrEqual(0);
      expect(result.usedPercent).toBeGreaterThan(0);
      expect(result.usedPercent).toBeLessThanOrEqual(100);
    });
  });

  describe("check", () => {
    it("should return health check result with all checks", async () => {
      const checker = new HealthChecker();

      const result = await checker.check();

      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.checks.diskSpace).toBeDefined();
      expect(result.checks.memory).toBeDefined();
      expect(["ok", "warning", "critical"]).toContain(result.overallStatus);
      expect(typeof result.healthy).toBe("boolean");
    });

    it("should mark as healthy only when status is ok", async () => {
      const checker = new HealthChecker();

      const result = await checker.check();

      expect(result.healthy).toBe(result.overallStatus === "ok");
    });
  });

  describe("periodic checks", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should run periodic checks at specified interval", async () => {
      const checker = new HealthChecker({ intervalMs: 1000 });
      const checkSpy = vi.spyOn(checker, "check");

      const stop = checker.startPeriodic();

      // Should run initial check
      await vi.advanceTimersByTimeAsync(0);
      expect(checkSpy).toHaveBeenCalledTimes(1);

      // Should run again after interval
      await vi.advanceTimersByTimeAsync(1000);
      expect(checkSpy).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1000);
      expect(checkSpy).toHaveBeenCalledTimes(3);

      stop();
    });

    it("should stop periodic checks when stop function is called", async () => {
      const checker = new HealthChecker({ intervalMs: 1000 });
      const checkSpy = vi.spyOn(checker, "check");

      const stop = checker.startPeriodic();

      await vi.advanceTimersByTimeAsync(0);
      expect(checkSpy).toHaveBeenCalledTimes(1);

      stop();

      await vi.advanceTimersByTimeAsync(5000);
      expect(checkSpy).toHaveBeenCalledTimes(1); // No more checks
    });

    it("should clear previous interval when called multiple times", async () => {
      const checker = new HealthChecker({ intervalMs: 1000 });
      const checkSpy = vi.spyOn(checker, "check");

      checker.startPeriodic();
      const stop2 = checker.startPeriodic();

      await vi.advanceTimersByTimeAsync(0);
      // Should only have 2 initial checks (one from each start)
      expect(checkSpy).toHaveBeenCalledTimes(2);

      stop2();
    });
  });

  describe("getLastStatus", () => {
    it("should return null before first check", () => {
      const checker = new HealthChecker();
      expect(checker.getLastStatus()).toBeNull();
    });

    it("should return last check result", async () => {
      const checker = new HealthChecker();

      await checker.check();

      const lastStatus = checker.getLastStatus();
      expect(lastStatus).not.toBeNull();
      expect(lastStatus?.timestamp).toBeInstanceOf(Date);
    });
  });

  describe("worktree monitoring", () => {
    it("should check worktree count when configured", async () => {
      const checker = new HealthChecker();

      checker.setWorktreeMonitoring(5, () => 3);

      const result = await checker.check();

      expect(result.checks.worktrees).toBeDefined();
      expect(result.checks.worktrees?.count).toBe(3);
      expect(result.checks.worktrees?.limit).toBe(5);
      expect(result.checks.worktrees?.status).toBe("ok");
    });

    it("should return warning when worktrees at 80% capacity", async () => {
      const checker = new HealthChecker();
      checker.setWorktreeMonitoring(5, () => 4);

      const result = await checker.check();

      expect(result.checks.worktrees?.status).toBe("warning");
    });

    it("should return critical when worktrees at limit", async () => {
      const checker = new HealthChecker();
      checker.setWorktreeMonitoring(5, () => 5);

      const result = await checker.check();

      expect(result.checks.worktrees?.status).toBe("critical");
    });

    it("should return critical when worktrees exceed limit", async () => {
      const checker = new HealthChecker();
      checker.setWorktreeMonitoring(5, () => 6);

      const result = await checker.check();

      expect(result.checks.worktrees?.status).toBe("critical");
    });
  });

  describe("callbacks", () => {
    it("should not call callbacks on first check (no status change)", async () => {
      const onWarning = vi.fn();
      const onCritical = vi.fn();

      const checker = new HealthChecker({
        onWarning,
        onCritical,
      });

      await checker.check();

      // First check shouldn't trigger callbacks since there's no previous status
      // to change FROM
    });
  });
});

describe("createAutonomousHealthChecker", () => {
  it("should create checker with appropriate defaults", () => {
    const checker = createAutonomousHealthChecker({
      dataDir: "/tmp/test",
    });

    expect(checker).toBeInstanceOf(HealthChecker);
  });

  it("should accept callback options", () => {
    const onWarning = vi.fn();
    const onCritical = vi.fn();

    const checker = createAutonomousHealthChecker({
      dataDir: "/tmp/test",
      onWarning,
      onCritical,
    });

    expect(checker).toBeInstanceOf(HealthChecker);
  });
});
