import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const TEST_DIR = join(process.cwd(), ".test-debug-validation");

/**
 * Test the debug file detection patterns used in IssueProcessor.validateStagedFiles
 * This validates the regex patterns work correctly for various file types.
 */
describe("Debug File Validation", () => {
  let repoPath: string;

  // Debug file patterns (same as in issue-processor.ts)
  const debugFilePatterns = [
    { pattern: /^debug\.ts$/, reason: "Debug file" },
    { pattern: /^debug-.*\.ts$/, reason: "Debug file" },
    { pattern: /\.debug\.ts$/, reason: "Debug file" },
    { pattern: /\.debug\.js$/, reason: "Debug file" },
    { pattern: /^temp\.ts$/, reason: "Temporary file" },
    { pattern: /^tmp\.ts$/, reason: "Temporary file" },
    { pattern: /^scratch\.ts$/, reason: "Scratch file" },
    { pattern: /^play\.ts$/, reason: "Playground file" },
    { pattern: /^test-.*\.ts$/, reason: "Test file outside test directory" },
  ];

  function detectSuspiciousFile(filePath: string): { suspicious: boolean; reason?: string } {
    const basename = filePath.split("/").pop() ?? filePath;
    const dirPath = filePath.split("/").slice(0, -1).join("/");

    for (const { pattern, reason } of debugFilePatterns) {
      if (pattern.test(basename)) {
        // Special case: test-*.ts files in proper test directories are OK
        if (
          reason === "Test file outside test directory" &&
          (dirPath.includes("test") || dirPath.includes("tests") || dirPath.includes("__tests__"))
        ) {
          continue;
        }
        return { suspicious: true, reason };
      }
    }
    return { suspicious: false };
  }

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    repoPath = join(TEST_DIR, "test-repo");
    mkdirSync(repoPath, { recursive: true });

    // Initialize git repo
    execSync("git init", { cwd: repoPath, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: repoPath, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: repoPath, stdio: "ignore" });

    // Initial commit
    writeFileSync(join(repoPath, "README.md"), "# Test\n");
    execSync("git add .", { cwd: repoPath, stdio: "ignore" });
    execSync('git commit -m "Initial"', { cwd: repoPath, stdio: "ignore" });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("pattern detection", () => {
    it("detects debug.ts as suspicious", () => {
      const result = detectSuspiciousFile("debug.ts");
      expect(result.suspicious).toBe(true);
      expect(result.reason).toBe("Debug file");
    });

    it("detects debug-test.ts as suspicious", () => {
      const result = detectSuspiciousFile("debug-test.ts");
      expect(result.suspicious).toBe(true);
      expect(result.reason).toBe("Debug file");
    });

    it("detects foo.debug.ts as suspicious", () => {
      const result = detectSuspiciousFile("src/foo.debug.ts");
      expect(result.suspicious).toBe(true);
      expect(result.reason).toBe("Debug file");
    });

    it("detects temp.ts as suspicious", () => {
      const result = detectSuspiciousFile("temp.ts");
      expect(result.suspicious).toBe(true);
      expect(result.reason).toBe("Temporary file");
    });

    it("detects tmp.ts as suspicious", () => {
      const result = detectSuspiciousFile("tmp.ts");
      expect(result.suspicious).toBe(true);
      expect(result.reason).toBe("Temporary file");
    });

    it("detects scratch.ts as suspicious", () => {
      const result = detectSuspiciousFile("scratch.ts");
      expect(result.suspicious).toBe(true);
      expect(result.reason).toBe("Scratch file");
    });

    it("detects play.ts as suspicious", () => {
      const result = detectSuspiciousFile("play.ts");
      expect(result.suspicious).toBe(true);
      expect(result.reason).toBe("Playground file");
    });

    it("detects test-foo.ts outside test directory as suspicious", () => {
      const result = detectSuspiciousFile("src/test-foo.ts");
      expect(result.suspicious).toBe(true);
      expect(result.reason).toBe("Test file outside test directory");
    });

    it("allows test-foo.ts inside tests directory", () => {
      const result = detectSuspiciousFile("tests/test-foo.ts");
      expect(result.suspicious).toBe(false);
    });

    it("allows test-foo.ts inside __tests__ directory", () => {
      const result = detectSuspiciousFile("src/__tests__/test-foo.ts");
      expect(result.suspicious).toBe(false);
    });

    it("allows normal source files", () => {
      expect(detectSuspiciousFile("src/index.ts").suspicious).toBe(false);
      expect(detectSuspiciousFile("src/utils/helper.ts").suspicious).toBe(false);
      expect(detectSuspiciousFile("lib/core.js").suspicious).toBe(false);
    });

    it("allows legitimate test files", () => {
      expect(detectSuspiciousFile("tests/unit.test.ts").suspicious).toBe(false);
      expect(detectSuspiciousFile("src/__tests__/foo.spec.ts").suspicious).toBe(false);
    });
  });

  describe("integration with git", () => {
    it("detects debug files in staged changes", () => {
      // Create suspicious files
      writeFileSync(join(repoPath, "debug.ts"), "console.log('debug');\n");
      writeFileSync(join(repoPath, "src", "valid.ts").replace("src/", ""), "export const x = 1;\n");
      mkdirSync(join(repoPath, "src"), { recursive: true });
      writeFileSync(join(repoPath, "src", "valid.ts"), "export const x = 1;\n");

      // Stage files
      execSync("git add -A", { cwd: repoPath, stdio: "ignore" });

      // Get staged files
      const stagedOutput = execSync("git diff --cached --name-only", {
        cwd: repoPath,
        encoding: "utf-8",
      });

      const stagedFiles = stagedOutput.split("\n").filter((f) => f.trim());
      const suspicious = stagedFiles.filter((f) => detectSuspiciousFile(f).suspicious);

      expect(suspicious).toContain("debug.ts");
      expect(suspicious).not.toContain("src/valid.ts");
    });

    it("detects multiple types of debug files", () => {
      // Create various debug files
      writeFileSync(join(repoPath, "debug.ts"), "// debug\n");
      writeFileSync(join(repoPath, "debug-test.ts"), "// debug test\n");
      writeFileSync(join(repoPath, "temp.ts"), "// temp\n");
      writeFileSync(join(repoPath, "play.ts"), "// play\n");

      execSync("git add -A", { cwd: repoPath, stdio: "ignore" });

      const stagedOutput = execSync("git diff --cached --name-only", {
        cwd: repoPath,
        encoding: "utf-8",
      });

      const stagedFiles = stagedOutput.split("\n").filter((f) => f.trim());
      const suspicious = stagedFiles.filter((f) => detectSuspiciousFile(f).suspicious);

      expect(suspicious).toHaveLength(4);
      expect(suspicious).toContain("debug.ts");
      expect(suspicious).toContain("debug-test.ts");
      expect(suspicious).toContain("temp.ts");
      expect(suspicious).toContain("play.ts");
    });
  });
});
