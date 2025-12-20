import { describe, it, expect, vi, beforeEach } from "vitest";
import { CICheckPoller } from "../../src/core/github/ci-poller.js";
import { CICheckHandler } from "../../src/core/engine/ci-handler.js";
import { PRService } from "../../src/core/github/pr-service.js";
import { GitOperations } from "../../src/core/git/git-operations.js";
import { AIProvider, QueryResult } from "../../src/core/ai/types.js";
import { PRCheck } from "../../src/types/pr.js";

// Mock implementations
const createMockPRService = () => ({
  getChecks: vi.fn(),
  getCheckLogs: vi.fn(),
  parsePRUrl: vi.fn(),
  getPR: vi.fn(),
  getReviews: vi.fn(),
  getComments: vi.fn(),
  getPRFeedback: vi.fn(),
  isAvailable: vi.fn(),
});

const createMockGitOps = () => ({
  hasUncommittedChanges: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  getHeadSha: vi.fn(),
});

const createMockAIProvider = (): AIProvider => ({
  name: "mock",
  query: vi.fn(),
  isAvailable: vi.fn().mockResolvedValue(true),
});

const createMockCheck = (
  name: string,
  status: "pending" | "success" | "failure",
  id = "1"
): PRCheck => ({
  id,
  name,
  status,
  conclusion: status === "pending" ? null : status,
  detailsUrl: null,
  startedAt: new Date(),
  completedAt: status === "pending" ? null : new Date(),
  outputSummary: null,
  outputText: null,
});

describe("CICheckPoller", () => {
  let prService: ReturnType<typeof createMockPRService>;
  let poller: CICheckPoller;

  beforeEach(() => {
    prService = createMockPRService();
    poller = new CICheckPoller(prService as unknown as PRService);
  });

  describe("waitForChecks", () => {
    it("should return no_checks when no checks are configured", async () => {
      prService.getChecks.mockResolvedValue([]);

      const result = await poller.waitForChecks("owner", "repo", 1, {
        timeoutMs: 5000,
        pollIntervalMs: 100,
      });

      expect(result.status).toBe("no_checks");
      expect(result.checks).toHaveLength(0);
    });

    it("should return success when all checks pass immediately", async () => {
      prService.getChecks.mockResolvedValue([
        createMockCheck("lint", "success"),
        createMockCheck("test", "success"),
      ]);

      const result = await poller.waitForChecks("owner", "repo", 1, {
        timeoutMs: 5000,
        pollIntervalMs: 100,
      });

      expect(result.status).toBe("success");
      expect(result.passedChecks).toHaveLength(2);
      expect(result.failedChecks).toHaveLength(0);
    });

    it("should return failure when any check fails", async () => {
      prService.getChecks.mockResolvedValue([
        createMockCheck("lint", "success"),
        createMockCheck("test", "failure"),
      ]);

      const result = await poller.waitForChecks("owner", "repo", 1, {
        timeoutMs: 5000,
        pollIntervalMs: 100,
      });

      expect(result.status).toBe("failure");
      expect(result.passedChecks).toHaveLength(1);
      expect(result.failedChecks).toHaveLength(1);
      expect(result.failedChecks[0]?.name).toBe("test");
    });

    it("should poll until checks complete", async () => {
      let callCount = 0;
      prService.getChecks.mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return [createMockCheck("test", "pending")];
        }
        return [createMockCheck("test", "success")];
      });

      const result = await poller.waitForChecks("owner", "repo", 1, {
        timeoutMs: 5000,
        pollIntervalMs: 50,
      });

      expect(result.status).toBe("success");
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it("should timeout if checks don't complete", async () => {
      prService.getChecks.mockResolvedValue([createMockCheck("test", "pending")]);

      const result = await poller.waitForChecks("owner", "repo", 1, {
        timeoutMs: 200,
        pollIntervalMs: 50,
      });

      expect(result.status).toBe("timeout");
    });

    it("should filter by required checks if specified", async () => {
      prService.getChecks.mockResolvedValue([
        createMockCheck("lint", "success"),
        createMockCheck("test", "failure"),
        createMockCheck("deploy", "pending"),
      ]);

      const result = await poller.waitForChecks("owner", "repo", 1, {
        timeoutMs: 5000,
        pollIntervalMs: 100,
        requiredChecks: ["lint"],
      });

      // Only lint is required, and it passed
      expect(result.status).toBe("success");
      expect(result.checks).toHaveLength(1);
    });

    it("should call onProgress callback", async () => {
      prService.getChecks.mockResolvedValue([createMockCheck("test", "success")]);

      const onProgress = vi.fn();

      await poller.waitForChecks("owner", "repo", 1, {
        timeoutMs: 5000,
        pollIntervalMs: 100,
        onProgress,
      });

      expect(onProgress).toHaveBeenCalled();
      expect(onProgress.mock.calls[0]?.[0]).toMatchObject({
        totalChecks: 1,
        completedChecks: 1,
        passedChecks: 1,
        failedChecks: 0,
        pendingChecks: 0,
      });
    });
  });

  describe("hasConfiguredChecks", () => {
    it("should return true when checks exist", async () => {
      prService.getChecks.mockResolvedValue([createMockCheck("test", "success")]);

      const result = await poller.hasConfiguredChecks("owner", "repo", 1);
      expect(result).toBe(true);
    });

    it("should return false when no checks exist", async () => {
      prService.getChecks.mockResolvedValue([]);

      const result = await poller.hasConfiguredChecks("owner", "repo", 1);
      expect(result).toBe(false);
    });

    it("should return false on error", async () => {
      prService.getChecks.mockRejectedValue(new Error("API error"));

      const result = await poller.hasConfiguredChecks("owner", "repo", 1);
      expect(result).toBe(false);
    });
  });
});

describe("CICheckHandler", () => {
  let prService: ReturnType<typeof createMockPRService>;
  let gitOps: ReturnType<typeof createMockGitOps>;
  let aiProvider: AIProvider;
  let handler: CICheckHandler;

  beforeEach(() => {
    prService = createMockPRService();
    gitOps = createMockGitOps();
    aiProvider = createMockAIProvider();
    handler = new CICheckHandler(
      prService as unknown as PRService,
      gitOps as unknown as GitOperations,
      aiProvider
    );
  });

  describe("handleChecks", () => {
    it("should return skipped when waitForChecks is false", async () => {
      const result = await handler.handleChecks("owner", "repo", 1, "/path", "branch", {
        maxIterations: 3,
        waitForChecks: false,
        autoFix: true,
        timeoutMs: 5000,
        pollIntervalMs: 100,
      });

      expect(result.finalStatus).toBe("skipped");
      expect(result.iterations).toHaveLength(0);
    });

    it("should return no_checks when repository has no CI", async () => {
      prService.getChecks.mockResolvedValue([]);

      const result = await handler.handleChecks("owner", "repo", 1, "/path", "branch", {
        maxIterations: 3,
        waitForChecks: true,
        autoFix: true,
        timeoutMs: 5000,
        pollIntervalMs: 100,
      });

      expect(result.finalStatus).toBe("no_checks");
    });

    it("should return success when all checks pass", async () => {
      prService.getChecks.mockResolvedValue([
        createMockCheck("lint", "success"),
        createMockCheck("test", "success"),
      ]);

      const result = await handler.handleChecks("owner", "repo", 1, "/path", "branch", {
        maxIterations: 3,
        waitForChecks: true,
        autoFix: true,
        timeoutMs: 5000,
        pollIntervalMs: 100,
      });

      expect(result.finalStatus).toBe("success");
      expect(result.iterations).toHaveLength(1);
      expect(result.iterations[0]?.fixApplied).toBe(false);
    });

    it("should return failure when checks fail and autoFix is disabled", async () => {
      prService.getChecks.mockResolvedValue([createMockCheck("test", "failure")]);

      const result = await handler.handleChecks("owner", "repo", 1, "/path", "branch", {
        maxIterations: 3,
        waitForChecks: true,
        autoFix: false,
        timeoutMs: 5000,
        pollIntervalMs: 100,
      });

      expect(result.finalStatus).toBe("failure");
      expect(result.summary).toContain("Auto-fix is disabled");
    });

    it("should attempt to fix when checks fail and autoFix is enabled", async () => {
      // First call: check fails
      // Second call: check passes (after fix)
      let callCount = 0;
      prService.getChecks.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return [createMockCheck("test", "failure")];
        }
        return [createMockCheck("test", "success")];
      });

      prService.getCheckLogs.mockResolvedValue("Error: test failed");
      gitOps.hasUncommittedChanges.mockResolvedValue(true);
      gitOps.getHeadSha.mockResolvedValue("abc123");

      const mockQueryResult: QueryResult = {
        success: true,
        output: "Fixed the test by updating assertions",
        turns: 5,
        costUsd: 0.01,
        durationMs: 1000,
      };
      vi.mocked(aiProvider.query).mockResolvedValue(mockQueryResult);

      const result = await handler.handleChecks("owner", "repo", 1, "/path", "branch", {
        maxIterations: 3,
        waitForChecks: true,
        autoFix: true,
        timeoutMs: 5000,
        pollIntervalMs: 100,
      });

      expect(result.finalStatus).toBe("success");
      expect(result.iterations).toHaveLength(2);
      expect(result.iterations[0]?.fixApplied).toBe(true);
      expect(gitOps.commit).toHaveBeenCalled();
      expect(gitOps.push).toHaveBeenCalled();
    });

    it("should return failure when AI cannot fix the issue", async () => {
      prService.getChecks.mockResolvedValue([createMockCheck("test", "failure")]);
      prService.getCheckLogs.mockResolvedValue("Error: test failed");
      gitOps.hasUncommittedChanges.mockResolvedValue(false); // AI didn't make changes

      const mockQueryResult: QueryResult = {
        success: true,
        output: "I could not fix the issue",
        turns: 5,
        costUsd: 0.01,
        durationMs: 1000,
      };
      vi.mocked(aiProvider.query).mockResolvedValue(mockQueryResult);

      const result = await handler.handleChecks("owner", "repo", 1, "/path", "branch", {
        maxIterations: 3,
        waitForChecks: true,
        autoFix: true,
        timeoutMs: 5000,
        pollIntervalMs: 100,
      });

      expect(result.finalStatus).toBe("failure");
      expect(result.summary).toContain("could not be fixed");
    });

    it("should respect maxIterations limit", async () => {
      // Always return failure
      prService.getChecks.mockResolvedValue([createMockCheck("test", "failure")]);
      prService.getCheckLogs.mockResolvedValue("Error");
      gitOps.hasUncommittedChanges.mockResolvedValue(true);
      gitOps.getHeadSha.mockResolvedValue("abc123");

      const mockQueryResult: QueryResult = {
        success: true,
        output: "Attempted fix",
        turns: 1,
        costUsd: 0.01,
        durationMs: 100,
      };
      vi.mocked(aiProvider.query).mockResolvedValue(mockQueryResult);

      const result = await handler.handleChecks("owner", "repo", 1, "/path", "branch", {
        maxIterations: 2,
        waitForChecks: true,
        autoFix: true,
        timeoutMs: 5000,
        pollIntervalMs: 100,
      });

      expect(result.finalStatus).toBe("max_iterations");
      expect(result.iterations.length).toBeLessThanOrEqual(2);
    });

    it("should call onProgress callback during handling", async () => {
      prService.getChecks.mockResolvedValue([createMockCheck("test", "success")]);

      const onProgress = vi.fn();

      await handler.handleChecks("owner", "repo", 1, "/path", "branch", {
        maxIterations: 3,
        waitForChecks: true,
        autoFix: true,
        timeoutMs: 5000,
        pollIntervalMs: 100,
        onProgress,
      });

      expect(onProgress).toHaveBeenCalled();
      const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
      expect(lastCall?.[0]?.phase).toBe("waiting");
    });

    it("should handle timeout correctly", async () => {
      prService.getChecks.mockResolvedValue([createMockCheck("test", "pending")]);

      const result = await handler.handleChecks("owner", "repo", 1, "/path", "branch", {
        maxIterations: 3,
        waitForChecks: true,
        autoFix: true,
        timeoutMs: 200,
        pollIntervalMs: 50,
      });

      expect(result.finalStatus).toBe("timeout");
    });
  });
});

describe("CI Config Schema", () => {
  it("should have correct default values", async () => {
    const { CICheckConfigSchema } = await import("../../src/types/config.js");

    const config = CICheckConfigSchema.parse({});

    expect(config.waitForChecks).toBe(true);
    expect(config.autoFixFailedChecks).toBe(true);
    expect(config.timeoutMs).toBe(30 * 60 * 1000); // 30 min
    expect(config.pollIntervalMs).toBe(30 * 1000); // 30 sec
    expect(config.initialDelayMs).toBe(15 * 1000); // 15 sec
    expect(config.maxFixIterations).toBe(3);
    expect(config.maxBudgetPerFix).toBe(2);
  });

  it("should allow overriding defaults", async () => {
    const { CICheckConfigSchema } = await import("../../src/types/config.js");

    const config = CICheckConfigSchema.parse({
      waitForChecks: false,
      autoFixFailedChecks: false,
      timeoutMs: 60000,
      pollIntervalMs: 10000,
      initialDelayMs: 5000,
      maxFixIterations: 5,
      maxBudgetPerFix: 5,
      requiredChecks: ["lint", "test"],
    });

    expect(config.waitForChecks).toBe(false);
    expect(config.autoFixFailedChecks).toBe(false);
    expect(config.timeoutMs).toBe(60000);
    expect(config.pollIntervalMs).toBe(10000);
    expect(config.initialDelayMs).toBe(5000);
    expect(config.maxFixIterations).toBe(5);
    expect(config.maxBudgetPerFix).toBe(5);
    expect(config.requiredChecks).toEqual(["lint", "test"]);
  });
});
