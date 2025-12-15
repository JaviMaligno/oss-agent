/**
 * Tests for the status command
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnvironment, createMockIssue, createMockSession } from "./helpers.js";
import { BudgetManager } from "../../src/core/engine/budget-manager.js";
import type { BudgetConfig } from "../../src/types/config.js";

describe("status command dependencies", () => {
  let env: ReturnType<typeof createTestEnvironment>;

  beforeEach(() => {
    env = createTestEnvironment();
  });

  afterEach(() => {
    env.cleanup();
  });

  describe("StateManager integration", () => {
    it("should return zero costs when database is empty", () => {
      const todaysCost = env.stateManager.getTodaysCost();
      expect(todaysCost).toBe(0);
    });

    it("should return zero PR counts when no PRs created", () => {
      const prCounts = env.stateManager.getTodaysPRCounts();
      expect(prCounts.daily).toBe(0);
      expect(Object.keys(prCounts.byProject)).toHaveLength(0);
    });

    it("should return empty array when no active sessions", () => {
      const activeSessions = env.stateManager.getActiveSessions();
      expect(activeSessions).toHaveLength(0);
    });

    it("should return empty array when no issues in progress", () => {
      const inProgressIssues = env.stateManager.getIssuesByState("in_progress");
      expect(inProgressIssues).toHaveLength(0);
    });

    it("should track issues in progress", () => {
      const issue = createMockIssue({ state: "in_progress" });
      env.stateManager.saveIssue(issue);

      const inProgressIssues = env.stateManager.getIssuesByState("in_progress");
      expect(inProgressIssues).toHaveLength(1);
      expect(inProgressIssues[0]?.title).toBe("Test Issue");
    });

    it("should track active sessions", () => {
      const issue = createMockIssue();
      env.stateManager.saveIssue(issue);

      const session = createMockSession({ issueId: issue.id, status: "active" });
      env.stateManager.createSession(session);

      const activeSessions = env.stateManager.getActiveSessions();
      expect(activeSessions).toHaveLength(1);
      expect(activeSessions[0]?.issueId).toBe(issue.id);
    });

    it("should return stats with correct counts", () => {
      // Create issues with unique URLs
      const issue1 = createMockIssue({
        id: "owner/repo#1",
        url: "https://github.com/owner/repo/issues/1",
        number: 1,
        state: "discovered",
      });
      const issue2 = createMockIssue({
        id: "owner/repo#2",
        url: "https://github.com/owner/repo/issues/2",
        number: 2,
        state: "in_progress",
      });
      env.stateManager.saveIssue(issue1);
      env.stateManager.saveIssue(issue2);

      // Create a session with cost
      const session = createMockSession({ issueId: issue1.id, costUsd: 1.5 });
      env.stateManager.createSession(session);

      const stats = env.stateManager.getStats();
      expect(stats.totalIssues).toBe(2);
      expect(stats.totalSessions).toBe(1);
      expect(stats.totalCostUsd).toBe(1.5);
    });
  });

  describe("BudgetManager integration", () => {
    it("should return budget status with costs from database", () => {
      const budgetConfig: BudgetConfig = {
        dailyLimitUsd: 50,
        monthlyLimitUsd: 500,
        perIssueLimitUsd: 5,
        perFeedbackIterationUsd: 1,
      };

      const budgetManager = new BudgetManager(env.stateManager, budgetConfig);
      const status = budgetManager.getStatus();

      expect(status.todaysCost).toBe(0);
      expect(status.monthsCost).toBe(0);
      expect(status.dailyExceeded).toBe(false);
    });

    it("should track costs through sessions", () => {
      // Create an issue and session with cost
      const issue = createMockIssue();
      env.stateManager.saveIssue(issue);

      const session = createMockSession({ issueId: issue.id, costUsd: 2.5 });
      const created = env.stateManager.createSession(session);
      expect(created.costUsd).toBe(2.5);

      // Verify cost is tracked
      const todaysCost = env.stateManager.getTodaysCost();
      expect(todaysCost).toBe(2.5);
    });

    it("should report exceeded when daily limit exceeded", () => {
      const budgetConfig: BudgetConfig = {
        dailyLimitUsd: 1, // Very low limit
        monthlyLimitUsd: 500,
        perIssueLimitUsd: 5,
        perFeedbackIterationUsd: 1,
      };

      // Create session that exceeds daily limit
      const issue = createMockIssue();
      env.stateManager.saveIssue(issue);
      env.stateManager.createSession(createMockSession({ issueId: issue.id, costUsd: 2.0 }));

      const budgetManager = new BudgetManager(env.stateManager, budgetConfig);
      const status = budgetManager.getStatus();

      expect(status.dailyExceeded).toBe(true);
      expect(status.dailyPercentUsed).toBe(200); // 2.00 / 1.00 * 100 = 200%
    });

    it("should use canProceed to check budget", () => {
      const budgetConfig: BudgetConfig = {
        dailyLimitUsd: 1,
        monthlyLimitUsd: 500,
        perIssueLimitUsd: 5,
        perFeedbackIterationUsd: 1,
      };

      // Create session that exceeds daily limit
      const issue = createMockIssue();
      env.stateManager.saveIssue(issue);
      env.stateManager.createSession(createMockSession({ issueId: issue.id, costUsd: 2.0 }));

      const budgetManager = new BudgetManager(env.stateManager, budgetConfig);
      const check = budgetManager.canProceed();

      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("Daily budget limit exceeded");
    });
  });

  describe("PR counts tracking", () => {
    it("should count PRs created today by project", () => {
      // Create an issue in queued state first (valid transition path: discovered -> queued -> in_progress -> pr_created)
      const issue = createMockIssue({
        state: "discovered",
        projectId: "owner/repo",
      });
      env.stateManager.saveIssue(issue);

      // Transition through valid states to pr_created
      env.stateManager.transitionIssue(issue.id, "queued", "Added to queue");
      env.stateManager.transitionIssue(issue.id, "in_progress", "Starting work");
      env.stateManager.transitionIssue(issue.id, "pr_created", "PR created");

      // Update issue with linked PR
      const updatedIssue = env.stateManager.getIssue(issue.id)!;
      updatedIssue.hasLinkedPR = true;
      updatedIssue.linkedPRUrl = "https://github.com/owner/repo/pull/1";
      env.stateManager.saveIssue(updatedIssue);

      const prCounts = env.stateManager.getTodaysPRCounts();
      expect(prCounts.daily).toBe(1);
      expect(prCounts.byProject["owner/repo"]).toBe(1);
    });
  });
});
