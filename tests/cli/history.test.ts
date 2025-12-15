/**
 * Tests for the history command
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnvironment, createMockIssue, createMockSession } from "./helpers.js";

describe("history command dependencies", () => {
  let env: ReturnType<typeof createTestEnvironment>;

  beforeEach(() => {
    env = createTestEnvironment();
  });

  afterEach(() => {
    env.cleanup();
  });

  describe("Session history", () => {
    it("should return empty history when no sessions exist", () => {
      const stats = env.stateManager.getStats();
      expect(stats.totalSessions).toBe(0);
    });

    it("should track session creation", () => {
      const issue = createMockIssue();
      env.stateManager.saveIssue(issue);

      const session = createMockSession({ issueId: issue.id });
      env.stateManager.createSession(session);

      const stats = env.stateManager.getStats();
      expect(stats.totalSessions).toBe(1);
    });

    it("should retrieve session by ID", () => {
      const issue = createMockIssue();
      env.stateManager.saveIssue(issue);

      const session = createMockSession({ issueId: issue.id });
      const created = env.stateManager.createSession(session);

      const retrieved = env.stateManager.getSession(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.issueId).toBe(issue.id);
    });

    it("should get latest session for an issue", () => {
      const issue = createMockIssue();
      env.stateManager.saveIssue(issue);

      // Create first session with an older timestamp
      const olderDate = new Date(Date.now() - 60000); // 1 minute ago
      const session1 = createMockSession({ issueId: issue.id, turnCount: 5, startedAt: olderDate });
      env.stateManager.createSession(session1);

      // Create second session with a newer timestamp
      const newerDate = new Date();
      const session2 = createMockSession({
        issueId: issue.id,
        turnCount: 10,
        startedAt: newerDate,
      });
      const created2 = env.stateManager.createSession(session2);

      const latest = env.stateManager.getLatestSessionForIssue(issue.id);
      expect(latest).not.toBeNull();
      // The latest session should be the one with turnCount 10 (newer timestamp)
      expect(latest?.turnCount).toBe(10);
      expect(latest?.id).toBe(created2.id);
    });

    it("should track session transitions", () => {
      const issue = createMockIssue();
      env.stateManager.saveIssue(issue);

      const session = createMockSession({ issueId: issue.id, status: "active" });
      const created = env.stateManager.createSession(session);

      // Transition to completed
      env.stateManager.transitionSession(created.id, "completed", "Work finished");

      const updated = env.stateManager.getSession(created.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.completedAt).not.toBeNull();
    });

    it("should track session metrics", () => {
      const issue = createMockIssue();
      env.stateManager.saveIssue(issue);

      const session = createMockSession({ issueId: issue.id });
      const created = env.stateManager.createSession(session);

      // Update metrics
      env.stateManager.updateSessionMetrics(created.id, {
        turnCount: 15,
        costUsd: 2.5,
        prUrl: "https://github.com/owner/repo/pull/1",
      });

      const updated = env.stateManager.getSession(created.id);
      expect(updated?.turnCount).toBe(15);
      expect(updated?.costUsd).toBe(2.5);
      expect(updated?.prUrl).toBe("https://github.com/owner/repo/pull/1");
    });
  });

  describe("Issue history", () => {
    it("should track issue state transitions", () => {
      const issue = createMockIssue({ state: "discovered" });
      env.stateManager.saveIssue(issue);

      // Transition through valid states: discovered -> queued -> in_progress -> pr_created
      env.stateManager.transitionIssue(issue.id, "queued", "Added to queue");
      env.stateManager.transitionIssue(issue.id, "in_progress", "Starting work");
      env.stateManager.transitionIssue(issue.id, "pr_created", "PR opened");

      const transitions = env.stateManager.getIssueTransitions(issue.id);
      expect(transitions).toHaveLength(3);
      expect(transitions[0]?.fromState).toBe("discovered");
      expect(transitions[0]?.toState).toBe("queued");
      expect(transitions[1]?.fromState).toBe("queued");
      expect(transitions[1]?.toState).toBe("in_progress");
      expect(transitions[2]?.fromState).toBe("in_progress");
      expect(transitions[2]?.toState).toBe("pr_created");
    });

    it("should record session ID in transitions", () => {
      const issue = createMockIssue({ state: "discovered" });
      env.stateManager.saveIssue(issue);

      const session = createMockSession({ issueId: issue.id });
      const created = env.stateManager.createSession(session);

      // Use valid transition path
      env.stateManager.transitionIssue(issue.id, "queued", "Added to queue", created.id);

      const transitions = env.stateManager.getIssueTransitions(issue.id);
      expect(transitions[0]?.sessionId).toBe(created.id);
    });

    it("should reject invalid transitions", () => {
      const issue = createMockIssue({ state: "discovered" });
      env.stateManager.saveIssue(issue);

      // Cannot go from discovered directly to in_progress (must go through queued first)
      expect(() => {
        env.stateManager.transitionIssue(issue.id, "in_progress", "Invalid");
      }).toThrow();
    });
  });

  describe("Work records", () => {
    it("should save and retrieve work records", () => {
      const issue = createMockIssue();
      env.stateManager.saveIssue(issue);

      const session = createMockSession({ issueId: issue.id });
      const created = env.stateManager.createSession(session);

      env.stateManager.saveWorkRecord({
        issueId: issue.id,
        sessionId: created.id,
        branchName: "fix/issue-1",
        worktreePath: "/tmp/worktree",
        attempts: 1,
        lastAttemptAt: new Date(),
        totalCostUsd: 1.5,
      });

      const record = env.stateManager.getWorkRecord(issue.id);
      expect(record).not.toBeNull();
      expect(record?.branchName).toBe("fix/issue-1");
      expect(record?.totalCostUsd).toBe(1.5);
    });

    it("should update existing work records", () => {
      const issue = createMockIssue();
      env.stateManager.saveIssue(issue);

      const session = createMockSession({ issueId: issue.id });
      const created = env.stateManager.createSession(session);

      // First attempt
      env.stateManager.saveWorkRecord({
        issueId: issue.id,
        sessionId: created.id,
        branchName: "fix/issue-1",
        worktreePath: "/tmp/worktree",
        attempts: 1,
        lastAttemptAt: new Date(),
        totalCostUsd: 1.5,
      });

      // Second attempt - should update
      env.stateManager.saveWorkRecord({
        issueId: issue.id,
        sessionId: created.id,
        branchName: "fix/issue-1",
        worktreePath: "/tmp/worktree",
        prNumber: 42,
        prUrl: "https://github.com/owner/repo/pull/42",
        attempts: 2,
        lastAttemptAt: new Date(),
        totalCostUsd: 3.0,
      });

      const record = env.stateManager.getWorkRecord(issue.id);
      expect(record?.attempts).toBe(2);
      expect(record?.prNumber).toBe(42);
      expect(record?.totalCostUsd).toBe(3.0);
    });

    it("should get work record by PR URL", () => {
      const issue = createMockIssue();
      env.stateManager.saveIssue(issue);

      const session = createMockSession({ issueId: issue.id });
      const created = env.stateManager.createSession(session);

      const prUrl = "https://github.com/owner/repo/pull/42";
      env.stateManager.saveWorkRecord({
        issueId: issue.id,
        sessionId: created.id,
        branchName: "fix/issue-1",
        worktreePath: "/tmp/worktree",
        prNumber: 42,
        prUrl,
        attempts: 1,
        lastAttemptAt: new Date(),
        totalCostUsd: 1.5,
      });

      const record = env.stateManager.getWorkRecordByPRUrl(prUrl);
      expect(record).not.toBeNull();
      expect(record?.issueId).toBe(issue.id);
    });

    it("should get all work records", () => {
      // Use unique URLs for each issue
      const issue1 = createMockIssue({
        id: "owner/repo#1",
        url: "https://github.com/owner/repo/issues/1",
        number: 1,
      });
      const issue2 = createMockIssue({
        id: "owner/repo#2",
        url: "https://github.com/owner/repo/issues/2",
        number: 2,
      });
      env.stateManager.saveIssue(issue1);
      env.stateManager.saveIssue(issue2);

      const session1 = createMockSession({ issueId: issue1.id });
      const session2 = createMockSession({ issueId: issue2.id });
      const created1 = env.stateManager.createSession(session1);
      const created2 = env.stateManager.createSession(session2);

      env.stateManager.saveWorkRecord({
        issueId: issue1.id,
        sessionId: created1.id,
        branchName: "fix/issue-1",
        worktreePath: "/tmp/worktree-1",
        attempts: 1,
        lastAttemptAt: new Date(),
        totalCostUsd: 1.0,
      });

      env.stateManager.saveWorkRecord({
        issueId: issue2.id,
        sessionId: created2.id,
        branchName: "fix/issue-2",
        worktreePath: "/tmp/worktree-2",
        attempts: 1,
        lastAttemptAt: new Date(),
        totalCostUsd: 2.0,
      });

      const allRecords = env.stateManager.getAllWorkRecords();
      expect(allRecords).toHaveLength(2);
    });
  });

  describe("Cost breakdown", () => {
    it("should return empty breakdown when no sessions", () => {
      const breakdown = env.stateManager.getCostBreakdown(7);
      expect(breakdown).toHaveLength(0);
    });

    it("should group costs by day", () => {
      const issue = createMockIssue();
      env.stateManager.saveIssue(issue);

      // Create sessions on today
      env.stateManager.createSession(createMockSession({ issueId: issue.id, costUsd: 1.0 }));
      env.stateManager.createSession(createMockSession({ issueId: issue.id, costUsd: 2.0 }));

      const breakdown = env.stateManager.getCostBreakdown(7);
      expect(breakdown).toHaveLength(1); // Just today
      expect(breakdown[0]?.cost).toBe(3.0); // Sum of both sessions
    });
  });
});
