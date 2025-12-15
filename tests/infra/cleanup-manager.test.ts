import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CleanupManager,
  registerWorktreeCleanup,
  registerTempFileCleanup,
  registerProcessCleanup,
} from "../../src/infra/cleanup-manager.js";

// Mock child_process
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Mock fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

describe("CleanupManager", () => {
  let cleanupManager: CleanupManager;

  beforeEach(() => {
    // Get a fresh instance for each test
    cleanupManager = CleanupManager.getInstance();
    // Clear any existing tasks from previous tests
    cleanupManager.clear();
  });

  describe("singleton", () => {
    it("should return the same instance", () => {
      const instance1 = CleanupManager.getInstance();
      const instance2 = CleanupManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe("register", () => {
    it("should register a cleanup task and return an id", () => {
      const taskId = cleanupManager.register({
        id: "test-task",
        type: "custom",
        description: "Test task",
        cleanup: async () => {},
      });

      expect(taskId).toBe("test-task");
    });

    it("should store the task with timestamp", () => {
      const taskId = cleanupManager.register({
        id: "test-task-2",
        type: "custom",
        description: "Test task",
        cleanup: async () => {},
      });

      const tasks = cleanupManager.getTasks();
      const task = tasks.find((t) => t.id === taskId);

      expect(task).toBeDefined();
      expect(task?.createdAt).toBeInstanceOf(Date);
    });
  });

  describe("unregister", () => {
    it("should remove a registered task", () => {
      const taskId = cleanupManager.register({
        id: "test-unregister",
        type: "custom",
        description: "Test task",
        cleanup: async () => {},
      });

      expect(cleanupManager.getTasks()).toHaveLength(1);

      const removed = cleanupManager.unregister(taskId);

      expect(removed).toBe(true);
      expect(cleanupManager.getTasks()).toHaveLength(0);
    });

    it("should return false for non-existent task", () => {
      const removed = cleanupManager.unregister("non-existent-id");
      expect(removed).toBe(false);
    });
  });

  describe("runAll", () => {
    it("should execute all cleanup tasks", async () => {
      const cleanup1 = vi.fn().mockResolvedValue(undefined);
      const cleanup2 = vi.fn().mockResolvedValue(undefined);

      cleanupManager.register({
        id: "task-1",
        type: "custom",
        description: "Task 1",
        cleanup: cleanup1,
      });

      cleanupManager.register({
        id: "task-2",
        type: "custom",
        description: "Task 2",
        cleanup: cleanup2,
      });

      const result = await cleanupManager.runAll();

      expect(cleanup1).toHaveBeenCalledTimes(1);
      expect(cleanup2).toHaveBeenCalledTimes(1);
      expect(result.success).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
    });

    it("should continue even if one task fails", async () => {
      const cleanup1 = vi.fn().mockRejectedValue(new Error("Task 1 failed"));
      const cleanup2 = vi.fn().mockResolvedValue(undefined);

      cleanupManager.register({
        id: "fail-task",
        type: "custom",
        description: "Task 1",
        cleanup: cleanup1,
      });

      cleanupManager.register({
        id: "success-task",
        type: "custom",
        description: "Task 2",
        cleanup: cleanup2,
      });

      const result = await cleanupManager.runAll();

      expect(cleanup1).toHaveBeenCalledTimes(1);
      expect(cleanup2).toHaveBeenCalledTimes(1);
      expect(result.success).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
    });

    it("should clear tasks after running", async () => {
      cleanupManager.register({
        id: "clear-task",
        type: "custom",
        description: "Task 1",
        cleanup: async () => {},
      });

      expect(cleanupManager.getTasks()).toHaveLength(1);

      await cleanupManager.runAll();

      expect(cleanupManager.getTasks()).toHaveLength(0);
    });
  });

  describe("getTasks", () => {
    it("should return all registered tasks", () => {
      cleanupManager.register({
        id: "worktree-task",
        type: "worktree",
        description: "Worktree 1",
        cleanup: async () => {},
      });

      cleanupManager.register({
        id: "tempfile-task",
        type: "temp-file",
        description: "Temp file 1",
        cleanup: async () => {},
      });

      const tasks = cleanupManager.getTasks();

      expect(tasks).toHaveLength(2);
      // Note: tasks may be in any order
      const types = tasks.map((t) => t.type);
      expect(types).toContain("worktree");
      expect(types).toContain("temp-file");
    });

    it("should return empty array when no tasks", () => {
      const tasks = cleanupManager.getTasks();
      expect(tasks).toHaveLength(0);
    });
  });

  describe("has", () => {
    it("should return true for registered task", () => {
      cleanupManager.register({
        id: "has-test",
        type: "custom",
        description: "Test",
        cleanup: async () => {},
      });

      expect(cleanupManager.has("has-test")).toBe(true);
    });

    it("should return false for unregistered task", () => {
      expect(cleanupManager.has("nonexistent")).toBe(false);
    });
  });

  describe("getTaskCount", () => {
    it("should return correct count", () => {
      expect(cleanupManager.getTaskCount()).toBe(0);

      cleanupManager.register({
        id: "count-1",
        type: "custom",
        description: "Test",
        cleanup: async () => {},
      });

      expect(cleanupManager.getTaskCount()).toBe(1);

      cleanupManager.register({
        id: "count-2",
        type: "custom",
        description: "Test",
        cleanup: async () => {},
      });

      expect(cleanupManager.getTaskCount()).toBe(2);
    });
  });
});

describe("registerWorktreeCleanup", () => {
  beforeEach(() => {
    CleanupManager.getInstance().clear();
  });

  it("should register a worktree cleanup task", () => {
    const taskId = registerWorktreeCleanup("/repo/path", "/worktree/path");

    expect(taskId).toBeDefined();
    expect(taskId).toContain("worktree");

    const manager = CleanupManager.getInstance();
    const tasks = manager.getTasks();
    const task = tasks.find((t) => t.id === taskId);

    expect(task?.type).toBe("worktree");
    expect(task?.description).toContain("/worktree/path");
  });
});

describe("registerTempFileCleanup", () => {
  beforeEach(() => {
    CleanupManager.getInstance().clear();
  });

  it("should register a temp file cleanup task", () => {
    const taskId = registerTempFileCleanup("/tmp/test-file.txt");

    expect(taskId).toBeDefined();
    expect(taskId).toContain("temp-file");

    const manager = CleanupManager.getInstance();
    const tasks = manager.getTasks();
    const task = tasks.find((t) => t.id === taskId);

    expect(task?.type).toBe("temp-file");
    expect(task?.description).toContain("/tmp/test-file.txt");
  });
});

describe("registerProcessCleanup", () => {
  beforeEach(() => {
    CleanupManager.getInstance().clear();
  });

  it("should register a process cleanup task", () => {
    const taskId = registerProcessCleanup(12345);

    expect(taskId).toBeDefined();
    expect(taskId).toContain("process");

    const manager = CleanupManager.getInstance();
    const tasks = manager.getTasks();
    const task = tasks.find((t) => t.id === taskId);

    expect(task?.type).toBe("process");
    expect(task?.description).toContain("12345");
  });

  it("should store PID in the task", () => {
    const taskId = registerProcessCleanup(12345, "SIGKILL");

    const manager = CleanupManager.getInstance();
    const tasks = manager.getTasks();
    const task = tasks.find((t) => t.id === taskId);

    // Check that it has the pid property
    expect(task).toBeDefined();
    expect((task as { pid?: number }).pid).toBe(12345);
  });
});

describe("shutdown handlers", () => {
  it("should install shutdown handlers without error", () => {
    const manager = CleanupManager.getInstance();

    // Should not throw
    expect(() => manager.installShutdownHandlers()).not.toThrow();
  });
});
