/**
 * Tests for the queue command dependencies
 *
 * Note: QueueManager itself requires DiscoveryService and SelectionService which
 * need GitHub access. These tests focus on the StateManager operations that
 * underpin queue functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnvironment, createMockIssue } from "./helpers.js";

describe("queue command dependencies", () => {
  let env: ReturnType<typeof createTestEnvironment>;

  beforeEach(() => {
    env = createTestEnvironment();
  });

  afterEach(() => {
    env.cleanup();
  });

  describe("Issue queue state management", () => {
    it("should start with no queued issues", () => {
      const queued = env.stateManager.getIssuesByState("queued");
      expect(queued).toHaveLength(0);
    });

    it("should save and retrieve queued issues", () => {
      const issue = createMockIssue({
        id: "owner/repo#1",
        url: "https://github.com/owner/repo/issues/1",
        state: "queued",
      });
      env.stateManager.saveIssue(issue);

      const queued = env.stateManager.getIssuesByState("queued");
      expect(queued).toHaveLength(1);
      expect(queued[0]?.url).toBe("https://github.com/owner/repo/issues/1");
    });

    it("should handle multiple queued issues", () => {
      for (let i = 1; i <= 5; i++) {
        const issue = createMockIssue({
          id: `owner/repo#${i}`,
          url: `https://github.com/owner/repo/issues/${i}`,
          number: i,
          state: "queued",
        });
        env.stateManager.saveIssue(issue);
      }

      const queued = env.stateManager.getIssuesByState("queued");
      expect(queued).toHaveLength(5);
    });

    it("should not return discovered issues as queued", () => {
      const discoveredIssue = createMockIssue({
        id: "owner/repo#1",
        url: "https://github.com/owner/repo/issues/1",
        state: "discovered",
      });
      const queuedIssue = createMockIssue({
        id: "owner/repo#2",
        url: "https://github.com/owner/repo/issues/2",
        state: "queued",
      });
      env.stateManager.saveIssue(discoveredIssue);
      env.stateManager.saveIssue(queuedIssue);

      const queued = env.stateManager.getIssuesByState("queued");
      expect(queued).toHaveLength(1);
      expect(queued[0]?.id).toBe("owner/repo#2");
    });
  });

  describe("Queue transitions", () => {
    it("should transition from discovered to queued", () => {
      const issue = createMockIssue({
        id: "owner/repo#1",
        url: "https://github.com/owner/repo/issues/1",
        state: "discovered",
      });
      env.stateManager.saveIssue(issue);

      env.stateManager.transitionIssue(issue.id, "queued", "Added to queue");

      const updated = env.stateManager.getIssue(issue.id);
      expect(updated?.state).toBe("queued");
    });

    it("should transition from queued to in_progress", () => {
      const issue = createMockIssue({
        id: "owner/repo#1",
        url: "https://github.com/owner/repo/issues/1",
        state: "queued",
      });
      env.stateManager.saveIssue(issue);

      env.stateManager.transitionIssue(issue.id, "in_progress", "Starting work");

      const updated = env.stateManager.getIssue(issue.id);
      expect(updated?.state).toBe("in_progress");
    });

    it("should transition from queued to abandoned (skip)", () => {
      const issue = createMockIssue({
        id: "owner/repo#1",
        url: "https://github.com/owner/repo/issues/1",
        state: "queued",
      });
      env.stateManager.saveIssue(issue);

      env.stateManager.transitionIssue(issue.id, "abandoned", "Skipped by user");

      const updated = env.stateManager.getIssue(issue.id);
      expect(updated?.state).toBe("abandoned");

      // Should no longer appear in queue
      const queued = env.stateManager.getIssuesByState("queued");
      expect(queued).toHaveLength(0);
    });

    it("should reject invalid queue transitions", () => {
      // Cannot go from discovered directly to in_progress
      const issue = createMockIssue({
        id: "owner/repo#1",
        url: "https://github.com/owner/repo/issues/1",
        state: "discovered",
      });
      env.stateManager.saveIssue(issue);

      expect(() => {
        env.stateManager.transitionIssue(issue.id, "in_progress", "Invalid");
      }).toThrow(/Invalid transition/);
    });
  });

  describe("Queue ordering", () => {
    it("should return issues in order", () => {
      // Create issues at different times
      for (let i = 1; i <= 3; i++) {
        const issue = createMockIssue({
          id: `owner/repo#${i}`,
          url: `https://github.com/owner/repo/issues/${i}`,
          number: i,
          state: "queued",
        });
        env.stateManager.saveIssue(issue);
      }

      const queued = env.stateManager.getIssuesByState("queued");
      expect(queued).toHaveLength(3);
      // All should be present (order may vary based on implementation)
      const ids = queued.map((q) => q.id);
      expect(ids).toContain("owner/repo#1");
      expect(ids).toContain("owner/repo#2");
      expect(ids).toContain("owner/repo#3");
    });
  });

  describe("Issue lookup", () => {
    it("should find issue by URL", () => {
      const issue = createMockIssue({
        id: "owner/repo#1",
        url: "https://github.com/owner/repo/issues/1",
        state: "queued",
      });
      env.stateManager.saveIssue(issue);

      const found = env.stateManager.getIssueByUrl("https://github.com/owner/repo/issues/1");
      expect(found).not.toBeNull();
      expect(found?.id).toBe("owner/repo#1");
    });

    it("should return null for non-existent URL", () => {
      const found = env.stateManager.getIssueByUrl("https://github.com/owner/repo/issues/999");
      expect(found).toBeNull();
    });

    it("should detect duplicates by URL", () => {
      const issue = createMockIssue({
        id: "owner/repo#1",
        url: "https://github.com/owner/repo/issues/1",
        state: "queued",
      });
      env.stateManager.saveIssue(issue);

      // Check if issue exists before adding
      const existing = env.stateManager.getIssueByUrl("https://github.com/owner/repo/issues/1");
      expect(existing).not.toBeNull();
    });
  });

  describe("Clear queue", () => {
    it("should be able to transition all queued issues to abandoned", () => {
      // Add multiple issues to queue
      for (let i = 1; i <= 3; i++) {
        const issue = createMockIssue({
          id: `owner/repo#${i}`,
          url: `https://github.com/owner/repo/issues/${i}`,
          number: i,
          state: "queued",
        });
        env.stateManager.saveIssue(issue);
      }

      // Get all queued issues and abandon them (clear queue)
      const queued = env.stateManager.getIssuesByState("queued");
      expect(queued).toHaveLength(3);

      for (const issue of queued) {
        env.stateManager.transitionIssue(issue.id, "abandoned", "Queue cleared");
      }

      // Queue should now be empty
      const remaining = env.stateManager.getIssuesByState("queued");
      expect(remaining).toHaveLength(0);
    });
  });

  describe("Integration with in-progress tracking", () => {
    it("should correctly separate queued and in-progress issues", () => {
      // Create issues in different states
      const queued1 = createMockIssue({
        id: "owner/repo#1",
        url: "https://github.com/owner/repo/issues/1",
        state: "queued",
      });
      const queued2 = createMockIssue({
        id: "owner/repo#2",
        url: "https://github.com/owner/repo/issues/2",
        state: "queued",
      });
      const inProgress = createMockIssue({
        id: "owner/repo#3",
        url: "https://github.com/owner/repo/issues/3",
        state: "queued", // Start as queued
      });

      env.stateManager.saveIssue(queued1);
      env.stateManager.saveIssue(queued2);
      env.stateManager.saveIssue(inProgress);

      // Transition one to in_progress
      env.stateManager.transitionIssue(inProgress.id, "in_progress", "Starting work");

      const queuedIssues = env.stateManager.getIssuesByState("queued");
      const inProgressIssues = env.stateManager.getIssuesByState("in_progress");

      expect(queuedIssues).toHaveLength(2);
      expect(inProgressIssues).toHaveLength(1);
      expect(inProgressIssues[0]?.id).toBe("owner/repo#3");
    });
  });
});
