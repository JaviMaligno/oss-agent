import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GitOperations } from "../../src/core/git/git-operations.js";
import { GitConfig } from "../../src/types/config.js";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const TEST_DIR = join(process.cwd(), ".test-git-ops");

describe("GitOperations", () => {
  let gitOps: GitOperations;
  let repoPath: string;

  const defaultConfig: GitConfig = {
    defaultBranch: "main",
    branchPrefix: "oss-agent",
    commitSignoff: false,
    workdirCleanupDays: 7,
    maxConcurrentClones: 3,
  };

  beforeEach(() => {
    // Clean up any existing test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    gitOps = new GitOperations(defaultConfig, TEST_DIR);
    repoPath = join(TEST_DIR, "test-repo");

    // Create a test git repository
    mkdirSync(repoPath, { recursive: true });
    execSync("git init", { cwd: repoPath, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: repoPath, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: repoPath, stdio: "ignore" });

    // Create initial commit
    writeFileSync(join(repoPath, "README.md"), "# Test Repo\n");
    execSync("git add .", { cwd: repoPath, stdio: "ignore" });
    execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: "ignore" });

    // Create a fake origin/main for comparison
    execSync("git branch -m main", { cwd: repoPath, stdio: "ignore" });
    execSync("git update-ref refs/remotes/origin/main HEAD", { cwd: repoPath, stdio: "ignore" });
    execSync("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: repoPath,
      stdio: "ignore",
    });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("getDiffStats", () => {
    it("returns zero stats when no changes", async () => {
      const stats = await gitOps.getDiffStats(repoPath, "main");

      expect(stats.files).toBe(0);
      expect(stats.insertions).toBe(0);
      expect(stats.deletions).toBe(0);
    });

    it("detects uncommitted changes", async () => {
      // Add a new file without committing
      writeFileSync(join(repoPath, "new-file.txt"), "Hello World\n");
      execSync("git add new-file.txt", { cwd: repoPath, stdio: "ignore" });

      const stats = await gitOps.getDiffStats(repoPath, "main");

      // Should detect staged changes
      expect(stats.files).toBeGreaterThanOrEqual(1);
      expect(stats.insertions).toBeGreaterThanOrEqual(1);
    });

    it("detects staged changes", async () => {
      // Modify existing file and stage
      writeFileSync(join(repoPath, "README.md"), "# Test Repo\n\nUpdated content\n");
      execSync("git add README.md", { cwd: repoPath, stdio: "ignore" });

      const stats = await gitOps.getDiffStats(repoPath, "main");

      expect(stats.files).toBeGreaterThanOrEqual(1);
      expect(stats.insertions).toBeGreaterThanOrEqual(1);
    });

    it("detects committed changes vs base branch", async () => {
      // Create and commit a change
      writeFileSync(join(repoPath, "new-file.txt"), "Line 1\nLine 2\nLine 3\n");
      execSync("git add new-file.txt", { cwd: repoPath, stdio: "ignore" });
      execSync('git commit -m "Add new file"', { cwd: repoPath, stdio: "ignore" });

      const stats = await gitOps.getDiffStats(repoPath, "main");

      expect(stats.files).toBe(1);
      expect(stats.insertions).toBe(3);
      expect(stats.deletions).toBe(0);
    });

    it("handles both insertions and deletions", async () => {
      // Modify file: remove some content, add some
      writeFileSync(join(repoPath, "README.md"), "New header\nNew line 1\nNew line 2\n");
      execSync("git add README.md", { cwd: repoPath, stdio: "ignore" });
      execSync('git commit -m "Update README"', { cwd: repoPath, stdio: "ignore" });

      const stats = await gitOps.getDiffStats(repoPath, "main");

      expect(stats.files).toBe(1);
      expect(stats.insertions).toBe(3); // 3 new lines
      expect(stats.deletions).toBe(1); // 1 old line removed
    });

    it("handles multiple changed files", async () => {
      // Create multiple files
      writeFileSync(join(repoPath, "file1.txt"), "Content 1\n");
      writeFileSync(join(repoPath, "file2.txt"), "Content 2\n");
      writeFileSync(join(repoPath, "file3.txt"), "Content 3\n");
      execSync("git add .", { cwd: repoPath, stdio: "ignore" });
      execSync('git commit -m "Add multiple files"', { cwd: repoPath, stdio: "ignore" });

      const stats = await gitOps.getDiffStats(repoPath, "main");

      expect(stats.files).toBe(3);
      expect(stats.insertions).toBe(3);
    });
  });

  describe("branchExists", () => {
    it("returns true for existing branch", async () => {
      const exists = await gitOps.branchExists(repoPath, "main");
      expect(exists).toBe(true);
    });

    it("returns false for non-existent branch", async () => {
      const exists = await gitOps.branchExists(repoPath, "non-existent-branch");
      expect(exists).toBe(false);
    });
  });

  describe("getCurrentBranch", () => {
    it("returns the current branch name", async () => {
      const branch = await gitOps.getCurrentBranch(repoPath);
      expect(branch).toBe("main");
    });

    it("returns new branch after checkout", async () => {
      execSync("git checkout -b feature-branch", { cwd: repoPath, stdio: "ignore" });
      const branch = await gitOps.getCurrentBranch(repoPath);
      expect(branch).toBe("feature-branch");
    });
  });

  describe("getDefaultBranch", () => {
    it("returns the default branch from origin/HEAD", async () => {
      const branch = await gitOps.getDefaultBranch(repoPath);
      expect(branch).toBe("main");
    });
  });

  describe("commit", () => {
    it("commits staged changes", async () => {
      writeFileSync(join(repoPath, "new-file.txt"), "Content\n");
      execSync("git add new-file.txt", { cwd: repoPath, stdio: "ignore" });

      const result = await gitOps.commit(repoPath, "Test commit message");

      expect(result.hash).toHaveLength(40); // Full SHA
      expect(result.message).toBe("Test commit message");

      // Verify the commit exists
      const log = execSync("git log --oneline -1", { cwd: repoPath, encoding: "utf-8" });
      expect(log).toContain("Test commit message");
    });

    it("throws when no changes to commit", async () => {
      await expect(gitOps.commit(repoPath, "Empty commit")).rejects.toThrow("No changes to commit");
    });

    it("allows empty commits with option", async () => {
      const result = await gitOps.commit(repoPath, "Empty commit", { allowEmpty: true });

      expect(result.hash).toHaveLength(40);
      expect(result.message).toBe("Empty commit");
    });
  });
});
