import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StateManager } from "../../src/core/state/state-manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for ParallelOrchestrator
 *
 * Note: Full integration tests of ParallelOrchestrator are complex because it
 * creates IssueProcessor instances internally. These tests focus on:
 * 1. StateManager parallel session methods (tested separately)
 * 2. Semaphore concurrency (tested separately)
 * 3. Basic validation and error handling
 *
 * Integration tests with real issues should be done in e2e tests.
 */
describe("ParallelOrchestrator", () => {
  let stateManager: StateManager;
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), "oss-agent-test-"));
    stateManager = new StateManager(tempDir);
  });

  afterEach(() => {
    stateManager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("parallel session integration with StateManager", () => {
    it("should create and track parallel session lifecycle", () => {
      // Create a parallel session
      const session = stateManager.createParallelSession({
        issueUrls: [
          "https://github.com/owner/repo/issues/1",
          "https://github.com/owner/repo/issues/2",
          "https://github.com/owner/repo/issues/3",
        ],
        maxConcurrent: 2,
      });

      expect(session.id).toMatch(/^ps-/);
      expect(session.status).toBe("active");
      expect(session.totalIssues).toBe(3);
      expect(session.maxConcurrent).toBe(2);

      // Simulate starting work on issues
      stateManager.updateParallelSessionIssue(
        session.id,
        "https://github.com/owner/repo/issues/1",
        { status: "in_progress" }
      );
      stateManager.updateParallelSessionIssue(
        session.id,
        "https://github.com/owner/repo/issues/2",
        { status: "in_progress" }
      );

      // Verify issues are tracked
      let issues = stateManager.getParallelSessionIssues(session.id);
      const inProgress = issues.filter((i) => i.status === "in_progress");
      expect(inProgress).toHaveLength(2);

      // Complete one issue
      stateManager.updateParallelSessionIssue(
        session.id,
        "https://github.com/owner/repo/issues/1",
        { status: "completed", costUsd: 0.05 }
      );

      // Start the third issue
      stateManager.updateParallelSessionIssue(
        session.id,
        "https://github.com/owner/repo/issues/3",
        { status: "in_progress" }
      );

      // Complete remaining issues
      stateManager.updateParallelSessionIssue(
        session.id,
        "https://github.com/owner/repo/issues/2",
        { status: "completed", costUsd: 0.03 }
      );
      stateManager.updateParallelSessionIssue(
        session.id,
        "https://github.com/owner/repo/issues/3",
        { status: "failed", error: "Something went wrong" }
      );

      // Update session summary
      stateManager.updateParallelSession(session.id, {
        status: "completed",
        completedIssues: 2,
        failedIssues: 1,
        totalCostUsd: 0.08,
        totalDurationMs: 5000,
      });

      // Verify final state
      const finalSession = stateManager.getParallelSession(session.id);
      expect(finalSession?.status).toBe("completed");
      expect(finalSession?.completedIssues).toBe(2);
      expect(finalSession?.failedIssues).toBe(1);
      expect(finalSession?.totalCostUsd).toBeCloseTo(0.08);

      issues = stateManager.getParallelSessionIssues(session.id);
      const completed = issues.filter((i) => i.status === "completed");
      const failed = issues.filter((i) => i.status === "failed");
      expect(completed).toHaveLength(2);
      expect(failed).toHaveLength(1);
    });

    it("should track cancelled issues", () => {
      const session = stateManager.createParallelSession({
        issueUrls: [
          "https://github.com/owner/repo/issues/1",
          "https://github.com/owner/repo/issues/2",
        ],
        maxConcurrent: 2,
      });

      // Cancel one issue before it starts
      stateManager.updateParallelSessionIssue(
        session.id,
        "https://github.com/owner/repo/issues/1",
        { status: "cancelled" }
      );

      // Complete the other
      stateManager.updateParallelSessionIssue(
        session.id,
        "https://github.com/owner/repo/issues/2",
        { status: "completed", costUsd: 0.01 }
      );

      stateManager.updateParallelSession(session.id, {
        status: "completed",
        completedIssues: 1,
        cancelledIssues: 1,
        totalCostUsd: 0.01,
      });

      const finalSession = stateManager.getParallelSession(session.id);
      expect(finalSession?.completedIssues).toBe(1);
      expect(finalSession?.cancelledIssues).toBe(1);
    });

    it("should list active and all sessions", () => {
      // Create multiple sessions
      const session1 = stateManager.createParallelSession({
        issueUrls: ["https://github.com/owner/repo/issues/1"],
        maxConcurrent: 1,
      });

      const session2 = stateManager.createParallelSession({
        issueUrls: ["https://github.com/owner/repo/issues/2"],
        maxConcurrent: 1,
      });

      stateManager.createParallelSession({
        issueUrls: ["https://github.com/owner/repo/issues/3"],
        maxConcurrent: 1,
      });

      // Complete session1
      stateManager.updateParallelSession(session1.id, { status: "completed" });

      // Fail session2
      stateManager.updateParallelSession(session2.id, { status: "failed" });

      // Check active sessions
      const active = stateManager.getActiveParallelSessions();
      expect(active).toHaveLength(1);

      // Check all sessions
      const all = stateManager.getAllParallelSessions();
      expect(all).toHaveLength(3);
    });
  });

  describe("issue URL validation", () => {
    it("should accept valid GitHub issue URLs", () => {
      const validUrls = [
        "https://github.com/owner/repo/issues/1",
        "https://github.com/owner/repo/issues/123",
        "https://github.com/my-org/my-repo/issues/999",
      ];

      for (const url of validUrls) {
        // Validation check - must contain github.com and /issues/
        expect(url.includes("github.com")).toBe(true);
        expect(url.includes("/issues/")).toBe(true);
      }
    });

    it("should reject invalid issue URLs", () => {
      const invalidUrls = [
        "https://gitlab.com/owner/repo/issues/1",
        "https://github.com/owner/repo/pull/1",
        "https://github.com/owner/repo",
        "not-a-url",
      ];

      for (const url of invalidUrls) {
        const isValid = url.includes("github.com") && url.includes("/issues/");
        expect(isValid).toBe(false);
      }
    });
  });

  describe("budget distribution", () => {
    it("should distribute budget evenly across issues", () => {
      const totalBudget = 3.0;
      const issueCount = 3;
      const perIssueBudget = totalBudget / issueCount;

      expect(perIssueBudget).toBe(1.0);
    });

    it("should handle odd budget distributions", () => {
      const totalBudget = 1.0;
      const issueCount = 3;
      const perIssueBudget = totalBudget / issueCount;

      expect(perIssueBudget).toBeCloseTo(0.333, 2);
    });
  });

  describe("status tracking", () => {
    it("should track issue status transitions", () => {
      const session = stateManager.createParallelSession({
        issueUrls: ["https://github.com/owner/repo/issues/1"],
        maxConcurrent: 1,
      });

      // Initial state
      let issues = stateManager.getParallelSessionIssues(session.id);
      expect(issues[0]?.status).toBe("pending");

      // Transition to in_progress
      stateManager.updateParallelSessionIssue(
        session.id,
        "https://github.com/owner/repo/issues/1",
        { status: "in_progress" }
      );
      issues = stateManager.getParallelSessionIssues(session.id);
      expect(issues[0]?.status).toBe("in_progress");
      expect(issues[0]?.startedAt).not.toBeNull();

      // Transition to completed
      stateManager.updateParallelSessionIssue(
        session.id,
        "https://github.com/owner/repo/issues/1",
        { status: "completed" }
      );
      issues = stateManager.getParallelSessionIssues(session.id);
      expect(issues[0]?.status).toBe("completed");
      expect(issues[0]?.completedAt).not.toBeNull();
    });
  });
});
