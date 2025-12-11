import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorktreeManager, WorktreeInfo } from "../../src/core/git/worktree-manager.js";
import { GitOperations } from "../../src/core/git/git-operations.js";
import { ParallelConfig } from "../../src/types/config.js";

// Mock GitOperations
const createMockGitOps = () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  listWorktrees: vi.fn(),
  getModifiedFiles: vi.fn(),
});

const createConfig = (overrides: Partial<ParallelConfig> = {}): ParallelConfig => ({
  maxConcurrentAgents: 3,
  maxConcurrentPerProject: 2,
  maxWorktrees: 10,
  maxWorktreesPerProject: 5,
  autoCleanupHours: 24,
  enableConflictDetection: true,
  ...overrides,
});

describe("WorktreeManager", () => {
  let manager: WorktreeManager;
  let mockGitOps: ReturnType<typeof createMockGitOps>;
  let config: ParallelConfig;

  beforeEach(() => {
    mockGitOps = createMockGitOps();
    config = createConfig();
    manager = new WorktreeManager(mockGitOps as unknown as GitOperations, config);
  });

  describe("create", () => {
    it("should create worktree and register it", async () => {
      mockGitOps.createWorktree.mockResolvedValue("/worktrees/test-repo-issue#1");

      const result = await manager.create(
        "/repos/test",
        "fix/issue-1",
        "owner/repo#1",
        "owner/repo"
      );

      expect(mockGitOps.createWorktree).toHaveBeenCalledWith(
        "/repos/test",
        "fix/issue-1",
        "owner/repo#1"
      );
      expect(result.path).toBe("/worktrees/test-repo-issue#1");
      expect(result.branchName).toBe("fix/issue-1");
      expect(result.issueId).toBe("owner/repo#1");
      expect(result.projectId).toBe("owner/repo");
      expect(result.status).toBe("active");
    });

    it("should throw when global limit reached", async () => {
      config = createConfig({ maxWorktrees: 2 });
      manager = new WorktreeManager(mockGitOps as unknown as GitOperations, config);

      mockGitOps.createWorktree.mockResolvedValue("/worktrees/wt1");
      await manager.create("/repos/test", "branch1", "issue1", "project1");

      mockGitOps.createWorktree.mockResolvedValue("/worktrees/wt2");
      await manager.create("/repos/test", "branch2", "issue2", "project1");

      await expect(manager.create("/repos/test", "branch3", "issue3", "project1")).rejects.toThrow(
        "Global worktree limit reached"
      );
    });

    it("should throw when per-project limit reached", async () => {
      config = createConfig({ maxWorktreesPerProject: 1 });
      manager = new WorktreeManager(mockGitOps as unknown as GitOperations, config);

      mockGitOps.createWorktree.mockResolvedValue("/worktrees/wt1");
      await manager.create("/repos/test", "branch1", "issue1", "projectA");

      await expect(manager.create("/repos/test", "branch2", "issue2", "projectA")).rejects.toThrow(
        "Per-project worktree limit reached"
      );
    });

    it("should allow different projects up to global limit", async () => {
      config = createConfig({ maxWorktreesPerProject: 1, maxWorktrees: 10 });
      manager = new WorktreeManager(mockGitOps as unknown as GitOperations, config);

      mockGitOps.createWorktree.mockResolvedValue("/worktrees/wt1");
      await manager.create("/repos/test", "branch1", "issue1", "projectA");

      mockGitOps.createWorktree.mockResolvedValue("/worktrees/wt2");
      const result = await manager.create("/repos/test", "branch2", "issue2", "projectB");

      expect(result.projectId).toBe("projectB");
    });
  });

  describe("remove", () => {
    it("should remove worktree and unregister it", async () => {
      mockGitOps.createWorktree.mockResolvedValue("/worktrees/wt1");
      await manager.create("/repos/test", "branch1", "issue1", "project1");

      expect(manager.list()).toHaveLength(1);

      await manager.remove("/repos/test", "/worktrees/wt1");

      expect(mockGitOps.removeWorktree).toHaveBeenCalledWith("/repos/test", "/worktrees/wt1");
      expect(manager.list()).toHaveLength(0);
    });
  });

  describe("markStatus", () => {
    it("should update worktree status", async () => {
      mockGitOps.createWorktree.mockResolvedValue("/worktrees/wt1");
      await manager.create("/repos/test", "branch1", "issue1", "project1");

      manager.markStatus("/worktrees/wt1", "completed");

      const wt = manager.get("/worktrees/wt1");
      expect(wt?.status).toBe("completed");
    });

    it("should do nothing for unknown worktree", () => {
      // Should not throw
      manager.markStatus("/unknown", "failed");
    });
  });

  describe("list methods", () => {
    beforeEach(async () => {
      mockGitOps.createWorktree
        .mockResolvedValueOnce("/worktrees/wt1")
        .mockResolvedValueOnce("/worktrees/wt2")
        .mockResolvedValueOnce("/worktrees/wt3");

      await manager.create("/repos/test", "branch1", "issue1", "projectA");
      await manager.create("/repos/test", "branch2", "issue2", "projectA");
      await manager.create("/repos/test", "branch3", "issue3", "projectB");
    });

    it("should list all worktrees", () => {
      expect(manager.list()).toHaveLength(3);
    });

    it("should list worktrees by project", () => {
      const projectA = manager.listByProject("projectA");
      expect(projectA).toHaveLength(2);

      const projectB = manager.listByProject("projectB");
      expect(projectB).toHaveLength(1);
    });

    it("should get worktree by path", () => {
      const wt = manager.get("/worktrees/wt2");
      expect(wt?.issueId).toBe("issue2");
    });

    it("should get worktree by issue ID", () => {
      const wt = manager.getByIssueId("issue3");
      expect(wt?.path).toBe("/worktrees/wt3");
    });

    it("should return null for unknown path", () => {
      expect(manager.get("/unknown")).toBeNull();
    });

    it("should return null for unknown issue ID", () => {
      expect(manager.getByIssueId("unknown")).toBeNull();
    });

    it("should get only active worktrees", async () => {
      manager.markStatus("/worktrees/wt1", "completed");
      manager.markStatus("/worktrees/wt2", "failed");

      const active = manager.getActive();
      expect(active).toHaveLength(1);
      expect(active[0]?.issueId).toBe("issue3");
    });
  });

  describe("canCreateMore", () => {
    it("should return allowed when under limits", () => {
      const result = manager.canCreateMore("projectA");
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("should return reason when global limit reached", async () => {
      config = createConfig({ maxWorktrees: 1 });
      manager = new WorktreeManager(mockGitOps as unknown as GitOperations, config);

      mockGitOps.createWorktree.mockResolvedValue("/worktrees/wt1");
      await manager.create("/repos/test", "branch1", "issue1", "projectA");

      const result = manager.canCreateMore("projectB");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Global worktree limit");
    });

    it("should return reason when per-project limit reached", async () => {
      config = createConfig({ maxWorktreesPerProject: 1 });
      manager = new WorktreeManager(mockGitOps as unknown as GitOperations, config);

      mockGitOps.createWorktree.mockResolvedValue("/worktrees/wt1");
      await manager.create("/repos/test", "branch1", "issue1", "projectA");

      const result = manager.canCreateMore("projectA");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Per-project worktree limit");
    });
  });

  describe("cleanupCompleted", () => {
    it("should remove completed worktrees", async () => {
      mockGitOps.createWorktree
        .mockResolvedValueOnce("/worktrees/wt1")
        .mockResolvedValueOnce("/worktrees/wt2");

      await manager.create("/repos/test", "branch1", "issue1", "project1");
      await manager.create("/repos/test", "branch2", "issue2", "project1");

      manager.markStatus("/worktrees/wt1", "completed");

      const count = await manager.cleanupCompleted("/repos/test");

      expect(count).toBe(1);
      expect(manager.list()).toHaveLength(1);
      expect(manager.get("/worktrees/wt2")).not.toBeNull();
    });
  });

  describe("cleanupByAge", () => {
    it("should remove worktrees older than specified hours", async () => {
      mockGitOps.createWorktree.mockResolvedValue("/worktrees/wt1");
      await manager.create("/repos/test", "branch1", "issue1", "project1");

      // Manually set createdAt to old date
      const wt = manager.get("/worktrees/wt1") as WorktreeInfo;
      wt.createdAt = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago

      const count = await manager.cleanupByAge("/repos/test", 24);

      expect(count).toBe(1);
      expect(manager.list()).toHaveLength(0);
    });

    it("should not remove recent worktrees", async () => {
      mockGitOps.createWorktree.mockResolvedValue("/worktrees/wt1");
      await manager.create("/repos/test", "branch1", "issue1", "project1");

      const count = await manager.cleanupByAge("/repos/test", 24);

      expect(count).toBe(0);
      expect(manager.list()).toHaveLength(1);
    });
  });

  describe("detectFileConflicts", () => {
    it("should detect no conflicts when files are unique", async () => {
      mockGitOps.getModifiedFiles
        .mockResolvedValueOnce(["file1.ts", "file2.ts"])
        .mockResolvedValueOnce(["file3.ts", "file4.ts"]);

      // Mock existsSync for the paths
      vi.mock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: vi.fn().mockReturnValue(true),
        };
      });

      const result = await manager.detectFileConflicts(["/wt1", "/wt2"]);

      expect(result.hasConflicts).toBe(false);
      expect(result.conflicts).toHaveLength(0);
    });

    it("should detect conflicts when files overlap", async () => {
      mockGitOps.getModifiedFiles
        .mockResolvedValueOnce(["shared.ts", "file1.ts"])
        .mockResolvedValueOnce(["shared.ts", "file2.ts"]);

      const result = await manager.detectFileConflicts(["/wt1", "/wt2"]);

      expect(result.hasConflicts).toBe(true);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.file).toBe("shared.ts");
      expect(result.conflicts[0]?.worktrees).toEqual(["/wt1", "/wt2"]);
    });

    it("should detect multiple file conflicts", async () => {
      mockGitOps.getModifiedFiles
        .mockResolvedValueOnce(["a.ts", "b.ts", "c.ts"])
        .mockResolvedValueOnce(["b.ts", "c.ts", "d.ts"])
        .mockResolvedValueOnce(["c.ts", "e.ts"]);

      const result = await manager.detectFileConflicts(["/wt1", "/wt2", "/wt3"]);

      expect(result.hasConflicts).toBe(true);
      // b.ts in wt1, wt2
      // c.ts in wt1, wt2, wt3
      expect(result.conflicts).toHaveLength(2);
    });
  });
});
