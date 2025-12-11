import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSuggestedQueries } from "../../src/oss/discovery/search-agent.js";

// Mock the logger
vi.mock("../../src/infra/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("search-agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getSuggestedQueries", () => {
    it("returns domain-specific suggestions when domain is provided", () => {
      const suggestions = getSuggestedQueries("ai-ml");

      expect(suggestions).toHaveLength(3);
      expect(suggestions[0]).toContain("ai-ml");
      expect(suggestions.some((s) => s.includes("tools") || s.includes("projects"))).toBe(true);
    });

    it("returns default suggestions when no domain provided", () => {
      const suggestions = getSuggestedQueries();

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions).toContain("Python CLI tools for developers");
      expect(suggestions).toContain("React component libraries with TypeScript");
    });

    it("returns default suggestions for unknown domain", () => {
      const suggestions = getSuggestedQueries("unknown-domain");

      expect(suggestions.length).toBeGreaterThan(0);
      // Should fall back to defaults
      expect(suggestions).toContain("Python CLI tools for developers");
    });

    it("returns suggestions for cybersecurity domain", () => {
      const suggestions = getSuggestedQueries("cybersecurity");

      expect(suggestions).toHaveLength(3);
      expect(suggestions[0]).toContain("cybersecurity");
    });

    it("returns suggestions for frontend domain", () => {
      const suggestions = getSuggestedQueries("frontend");

      expect(suggestions).toHaveLength(3);
      expect(suggestions[0]).toContain("frontend");
    });
  });
});
