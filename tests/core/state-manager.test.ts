import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Skip SQLite tests if native module not available
const SKIP_SQLITE_TESTS = false; // Set to true if better-sqlite3 is not built
import { StateManager } from "../../src/core/state/state-manager.js";
import { Issue } from "../../src/types/issue.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe.skipIf(SKIP_SQLITE_TESTS)("StateManager", () => {
  let stateManager: StateManager;
  let tempDir: string;

  // Helper to create a test issue
  const createTestIssue = (overrides: Partial<Issue> = {}): Issue => ({
    id: "owner/repo#1",
    url: "https://github.com/owner/repo/issues/1",
    number: 1,
    title: "Test Issue",
    body: "Test body",
    labels: ["bug"],
    state: "discovered",
    author: "testuser",
    assignee: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    projectId: "owner/repo",
    hasLinkedPR: false,
    linkedPRUrl: null,
    ...overrides,
  });

  // Helper to create and save an issue in DB
  const createIssueInDb = (overrides: Partial<Issue> = {}): Issue => {
    const issue = createTestIssue(overrides);
    stateManager.saveIssue(issue);
    return issue;
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "oss-agent-test-"));
    stateManager = new StateManager(tempDir);
  });

  afterEach(() => {
    stateManager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Issue Management", () => {
    it("should save and retrieve an issue", () => {
      const issue = createTestIssue();
      stateManager.saveIssue(issue);

      const retrieved = stateManager.getIssue(issue.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(issue.id);
      expect(retrieved?.title).toBe(issue.title);
      expect(retrieved?.labels).toEqual(["bug"]);
    });

    it("should retrieve issue by URL", () => {
      const issue = createTestIssue();
      stateManager.saveIssue(issue);

      const retrieved = stateManager.getIssueByUrl(issue.url);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(issue.id);
    });

    it("should return null for non-existent issue", () => {
      const retrieved = stateManager.getIssue("non-existent");
      expect(retrieved).toBeNull();
    });

    it("should update existing issue", () => {
      const issue = createTestIssue();
      stateManager.saveIssue(issue);

      const updatedIssue = { ...issue, title: "Updated Title" };
      stateManager.saveIssue(updatedIssue);

      const retrieved = stateManager.getIssue(issue.id);
      expect(retrieved?.title).toBe("Updated Title");
    });

    it("should get issues by state", () => {
      stateManager.saveIssue(
        createTestIssue({
          id: "owner/repo#1",
          url: "https://github.com/owner/repo/issues/1",
          state: "discovered",
        })
      );
      stateManager.saveIssue(
        createTestIssue({
          id: "owner/repo#2",
          url: "https://github.com/owner/repo/issues/2",
          state: "discovered",
        })
      );
      stateManager.saveIssue(
        createTestIssue({
          id: "owner/repo#3",
          url: "https://github.com/owner/repo/issues/3",
          state: "queued",
        })
      );

      const discovered = stateManager.getIssuesByState("discovered");
      expect(discovered).toHaveLength(2);

      const queued = stateManager.getIssuesByState("queued");
      expect(queued).toHaveLength(1);
    });
  });

  describe("Issue State Transitions", () => {
    it("should transition issue to valid state", () => {
      const issue = createIssueInDb({ state: "discovered" });

      stateManager.transitionIssue(issue.id, "queued", "Ready to process");

      const updated = stateManager.getIssue(issue.id);
      expect(updated?.state).toBe("queued");
    });

    it("should throw on invalid transition", () => {
      const issue = createIssueInDb({ state: "discovered" });

      expect(() => {
        stateManager.transitionIssue(issue.id, "merged", "Invalid transition");
      }).toThrow();
    });

    it("should record transition history", () => {
      const issue = createIssueInDb({ state: "discovered" });

      stateManager.transitionIssue(issue.id, "queued", "Ready to process");
      stateManager.transitionIssue(issue.id, "in_progress", "Starting work");

      const transitions = stateManager.getIssueTransitions(issue.id);
      expect(transitions).toHaveLength(2);
      expect(transitions[0]?.fromState).toBe("discovered");
      expect(transitions[0]?.toState).toBe("queued");
      expect(transitions[1]?.fromState).toBe("queued");
      expect(transitions[1]?.toState).toBe("in_progress");
    });

    it("should include session ID in transition", () => {
      const issue = createIssueInDb({ state: "discovered" });

      stateManager.transitionIssue(issue.id, "queued", "Ready", "session-123");

      const transitions = stateManager.getIssueTransitions(issue.id);
      expect(transitions[0]?.sessionId).toBe("session-123");
    });
  });

  describe("Session Management", () => {
    it("should create and retrieve session", () => {
      // Create issue first (foreign key constraint)
      const issue = createIssueInDb();

      const session = stateManager.createSession({
        issueId: issue.id,
        issueUrl: issue.url,
        status: "active",
        provider: "claude-cli",
        model: "claude-sonnet-4-20250514",
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
        turnCount: 0,
        costUsd: 0,
        prUrl: null,
        workingDirectory: "/tmp/work",
        canResume: true,
        error: null,
      });

      expect(session.id).toMatch(/^session-\d+-/);

      const retrieved = stateManager.getSession(session.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.issueId).toBe(issue.id);
      expect(retrieved?.status).toBe("active");
    });

    it("should transition session status", () => {
      const issue = createIssueInDb();

      const session = stateManager.createSession({
        issueId: issue.id,
        issueUrl: issue.url,
        status: "active",
        provider: "claude-cli",
        model: "claude-sonnet-4-20250514",
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
        turnCount: 0,
        costUsd: 0,
        prUrl: null,
        workingDirectory: "/tmp/work",
        canResume: true,
        error: null,
      });

      stateManager.transitionSession(session.id, "completed", "Done");

      const updated = stateManager.getSession(session.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.completedAt).not.toBeNull();
    });

    it("should update session metrics", () => {
      const issue = createIssueInDb();

      const session = stateManager.createSession({
        issueId: issue.id,
        issueUrl: issue.url,
        status: "active",
        provider: "claude-cli",
        model: "claude-sonnet-4-20250514",
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
        turnCount: 0,
        costUsd: 0,
        prUrl: null,
        workingDirectory: "/tmp/work",
        canResume: true,
        error: null,
      });

      stateManager.updateSessionMetrics(session.id, {
        turnCount: 10,
        costUsd: 0.05,
        prUrl: "https://github.com/owner/repo/pull/1",
      });

      const updated = stateManager.getSession(session.id);
      expect(updated?.turnCount).toBe(10);
      expect(updated?.costUsd).toBe(0.05);
      expect(updated?.prUrl).toBe("https://github.com/owner/repo/pull/1");
    });
  });

  describe("Statistics", () => {
    it("should return accurate statistics", () => {
      // Add some issues
      stateManager.saveIssue({
        id: "1",
        url: "https://github.com/owner/repo/issues/1",
        number: 1,
        title: "Issue 1",
        body: "",
        labels: [],
        state: "discovered",
        author: "user",
        assignee: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        projectId: "owner/repo",
        hasLinkedPR: false,
        linkedPRUrl: null,
      });

      stateManager.saveIssue({
        id: "2",
        url: "https://github.com/owner/repo/issues/2",
        number: 2,
        title: "Issue 2",
        body: "",
        labels: [],
        state: "merged",
        author: "user",
        assignee: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        projectId: "owner/repo",
        hasLinkedPR: true,
        linkedPRUrl: "https://github.com/owner/repo/pull/2",
      });

      const stats = stateManager.getStats();
      expect(stats.totalIssues).toBe(2);
      expect(stats.issuesByState.discovered).toBe(1);
      expect(stats.issuesByState.merged).toBe(1);
    });
  });
});
