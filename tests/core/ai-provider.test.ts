import { describe, it, expect } from "vitest";

/**
 * Tests for AI provider utilities and logic.
 * Note: These are unit tests for the logic, not integration tests
 * that require the actual Claude CLI to be installed.
 */
describe("AI Provider Logic", () => {
  describe("Claude CLI version detection", () => {
    /**
     * The isAvailable check looks for "claude" in the version output.
     * This should be case-insensitive to handle both:
     * - "claude 1.0.0" (older versions)
     * - "2.0.64 (Claude Code)" (newer versions)
     */
    const checkVersionOutput = (output: string): boolean => {
      return output.toLowerCase().includes("claude");
    };

    it("detects claude in lowercase output", () => {
      expect(checkVersionOutput("claude 1.0.0")).toBe(true);
    });

    it("detects Claude with capital C", () => {
      expect(checkVersionOutput("2.0.64 (Claude Code)")).toBe(true);
    });

    it("detects CLAUDE in uppercase", () => {
      expect(checkVersionOutput("CLAUDE CLI v3.0")).toBe(true);
    });

    it("returns false for non-claude output", () => {
      expect(checkVersionOutput("git version 2.39.0")).toBe(false);
      expect(checkVersionOutput("node v18.0.0")).toBe(false);
      expect(checkVersionOutput("")).toBe(false);
    });

    it("handles version strings with extra whitespace", () => {
      expect(checkVersionOutput("  Claude Code  \n")).toBe(true);
    });

    it("handles partial matches", () => {
      expect(checkVersionOutput("This is not claude-related")).toBe(true); // Contains "claude"
      expect(checkVersionOutput("claudette")).toBe(true); // Contains "claude"
    });
  });

  describe("Diff stats parsing", () => {
    /**
     * The getDiffStats function parses git diff --shortstat output.
     * Examples:
     * - " 3 files changed, 10 insertions(+), 5 deletions(-)"
     * - " 1 file changed, 2 insertions(+)"
     * - " 1 file changed, 1 deletion(-)"
     */
    const parseDiffStat = (
      stat: string
    ): { files: number; insertions: number; deletions: number } => {
      const match = stat.match(
        /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
      );
      if (!match) {
        return { files: 0, insertions: 0, deletions: 0 };
      }
      return {
        files: parseInt(match[1] ?? "0", 10),
        insertions: parseInt(match[2] ?? "0", 10),
        deletions: parseInt(match[3] ?? "0", 10),
      };
    };

    it("parses full stat with insertions and deletions", () => {
      const stat = " 3 files changed, 10 insertions(+), 5 deletions(-)";
      const result = parseDiffStat(stat);

      expect(result.files).toBe(3);
      expect(result.insertions).toBe(10);
      expect(result.deletions).toBe(5);
    });

    it("parses stat with only insertions", () => {
      const stat = " 2 files changed, 15 insertions(+)";
      const result = parseDiffStat(stat);

      expect(result.files).toBe(2);
      expect(result.insertions).toBe(15);
      expect(result.deletions).toBe(0);
    });

    it("parses stat with only deletions", () => {
      const stat = " 1 file changed, 8 deletions(-)";
      const result = parseDiffStat(stat);

      expect(result.files).toBe(1);
      expect(result.insertions).toBe(0);
      expect(result.deletions).toBe(8);
    });

    it("parses single file changed", () => {
      const stat = " 1 file changed, 1 insertion(+)";
      const result = parseDiffStat(stat);

      expect(result.files).toBe(1);
      expect(result.insertions).toBe(1);
      expect(result.deletions).toBe(0);
    });

    it("returns zeros for empty string", () => {
      const result = parseDiffStat("");

      expect(result.files).toBe(0);
      expect(result.insertions).toBe(0);
      expect(result.deletions).toBe(0);
    });

    it("returns zeros for unrelated output", () => {
      const result = parseDiffStat("On branch main");

      expect(result.files).toBe(0);
      expect(result.insertions).toBe(0);
      expect(result.deletions).toBe(0);
    });

    it("handles large numbers", () => {
      const stat = " 100 files changed, 5000 insertions(+), 3000 deletions(-)";
      const result = parseDiffStat(stat);

      expect(result.files).toBe(100);
      expect(result.insertions).toBe(5000);
      expect(result.deletions).toBe(3000);
    });
  });
});
