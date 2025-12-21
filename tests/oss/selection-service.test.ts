import { describe, it, expect } from "vitest";
import { SelectionService } from "../../src/oss/selection/selection-service.js";
import type { GitHubIssueInfo } from "../../src/types/issue.js";

function createMockIssue(overrides: Partial<GitHubIssueInfo> = {}): GitHubIssueInfo {
  return {
    id: "test/repo#1",
    url: "https://github.com/test/repo/issues/1",
    number: 1,
    title: "Test issue title with enough words",
    body: "This is a test issue body with sufficient content to be considered well-described. It contains multiple sentences and provides context.",
    state: "open",
    labels: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    author: "testuser",
    comments: [],
    assignees: [],
    repository: {
      owner: "test",
      name: "repo",
      fullName: "test/repo",
    },
    ...overrides,
  };
}

describe("SelectionService", () => {
  describe("calculateROI", () => {
    const service = new SelectionService();

    describe("formula", () => {
      it("should use geometric mean formula: sqrt(F*I) * (100-C)/100", () => {
        // Create an issue with predictable scores
        const issue = createMockIssue({
          body: "Clear description with steps to reproduce:\n1. Do this\n2. Then that\n\nExpected: X\nActual: Y",
          labels: ["bug"],
          comments: [
            {
              id: "1",
              author: "maintainer",
              body: "Try looking at file.ts",
              createdAt: new Date(),
            },
          ],
        });

        const roi = service.calculateROI(issue);

        // ROI should be in reasonable range (not 100)
        expect(roi.roi).toBeGreaterThan(0);
        expect(roi.roi).toBeLessThanOrEqual(100);

        // Verify formula: sqrt(F*I) * (100-C)/100
        const expected =
          (Math.sqrt(roi.feasibility.total * roi.impact.total) * (100 - roi.cost.total)) / 100;
        expect(roi.roi).toBe(Math.max(0, Math.min(100, Math.round(expected))));
      });

      it("should not easily hit 100 for typical issues", () => {
        const typicalIssue = createMockIssue({
          body: "When I do X, Y happens instead of Z. Here's the error:\n```\nError: something\n```",
          labels: ["bug"],
        });

        const roi = service.calculateROI(typicalIssue);

        // Typical issues should score in 30-70 range, not 100
        expect(roi.roi).toBeLessThan(80);
      });

      it("should give higher ROI for low-cost issues", () => {
        const lowCostIssue = createMockIssue({
          body: "Simple typo fix in README.md",
          labels: ["documentation"],
        });

        const highCostIssue = createMockIssue({
          body: "We need to refactor the entire authentication system across multiple components",
          labels: ["breaking", "refactor"],
        });

        const lowCostROI = service.calculateROI(lowCostIssue);
        const highCostROI = service.calculateROI(highCostIssue);

        expect(lowCostROI.cost.total).toBeLessThan(highCostROI.cost.total);
      });
    });

    describe("feasibility scoring", () => {
      it("should score higher for well-described issues", () => {
        const wellDescribed = createMockIssue({
          body: "## Problem\nDetailed description here with code examples.\n\n```typescript\nconst x = 1;\n```\n\n## Expected\nShould do X\n\n## Actual\nDoes Y instead",
        });

        const poorlyDescribed = createMockIssue({
          body: "broken",
        });

        const wellROI = service.calculateROI(wellDescribed);
        const poorROI = service.calculateROI(poorlyDescribed);

        expect(wellROI.feasibility.clarity).toBeGreaterThan(poorROI.feasibility.clarity);
      });

      it("should score higher for single-file scope", () => {
        const singleFile = createMockIssue({
          body: "The bug is in src/utils/helper.ts",
        });

        const manyFiles = createMockIssue({
          body: "This affects src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts",
        });

        const singleROI = service.calculateROI(singleFile);
        const manyROI = service.calculateROI(manyFiles);

        expect(singleROI.feasibility.scope).toBeGreaterThan(manyROI.feasibility.scope);
      });

      it("should score higher for actionable issues with repro steps", () => {
        const actionable = createMockIssue({
          body: "Steps to reproduce:\n1. Install package\n2. Run command\n3. See error\n\nExpected: works\nActual: crashes",
        });

        const vague = createMockIssue({
          body: "Something is broken, please fix",
        });

        const actionableROI = service.calculateROI(actionable);
        const vagueROI = service.calculateROI(vague);

        expect(actionableROI.feasibility.actionability).toBeGreaterThan(
          vagueROI.feasibility.actionability
        );
      });

      it("should score higher when guidance is provided", () => {
        const withGuidance = createMockIssue({
          body: "The issue is in the parser. I think the fix would be to check for null before accessing the property.",
        });

        const noGuidance = createMockIssue({
          body: "Something is wrong with parsing",
        });

        const guidedROI = service.calculateROI(withGuidance);
        const unguidedROI = service.calculateROI(noGuidance);

        expect(guidedROI.feasibility.guidance).toBeGreaterThan(unguidedROI.feasibility.guidance);
      });
    });

    describe("impact scoring", () => {
      it("should score higher for popular repos when context provided", () => {
        const issue = createMockIssue();

        const popularContext = { stars: 50000, forks: 5000 };
        const unpopularContext = { stars: 50, forks: 5 };

        const popularROI = service.calculateROI(issue, popularContext);
        const unpopularROI = service.calculateROI(issue, unpopularContext);

        expect(popularROI.impact.repoPopularity).toBeGreaterThan(
          unpopularROI.impact.repoPopularity
        );
      });

      it("should score bugs higher than features", () => {
        const bug = createMockIssue({ labels: ["bug"] });
        const feature = createMockIssue({ labels: ["enhancement"] });

        const bugROI = service.calculateROI(bug);
        const featureROI = service.calculateROI(feature);

        expect(bugROI.impact.labelImportance).toBeGreaterThan(featureROI.impact.labelImportance);
      });

      it("should score recent issues higher", () => {
        const recent = createMockIssue({ createdAt: new Date() });
        const old = createMockIssue({
          createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000), // 200 days ago
        });

        const recentROI = service.calculateROI(recent);
        const oldROI = service.calculateROI(old);

        expect(recentROI.impact.freshness).toBeGreaterThan(oldROI.impact.freshness);
      });

      it("should score good-first-issue labels higher", () => {
        const goodFirst = createMockIssue({ labels: ["good first issue"] });
        const noLabel = createMockIssue({ labels: [] });

        const goodFirstROI = service.calculateROI(goodFirst);
        const noLabelROI = service.calculateROI(noLabel);

        expect(goodFirstROI.impact.labelImportance).toBeGreaterThan(
          noLabelROI.impact.labelImportance
        );
      });
    });

    describe("cost scoring", () => {
      it("should score higher cost for complex labels", () => {
        const complex = createMockIssue({ labels: ["breaking", "security"] });
        const simple = createMockIssue({ labels: ["documentation"] });

        const complexROI = service.calculateROI(complex);
        const simpleROI = service.calculateROI(simple);

        expect(complexROI.cost.riskLabels).toBeGreaterThan(simpleROI.cost.riskLabels);
      });

      it("should score higher cost for contentious issues", () => {
        const contentious = createMockIssue({
          comments: Array.from({ length: 20 }, (_, i) => ({
            id: String(i),
            author: `user${i}`,
            body: "Comment",
            createdAt: new Date(),
          })),
        });

        const quiet = createMockIssue({ comments: [] });

        const contentiousROI = service.calculateROI(contentious);
        const quietROI = service.calculateROI(quiet);

        expect(contentiousROI.cost.contention).toBeGreaterThan(quietROI.cost.contention);
      });

      it("should detect complexity signals in description", () => {
        const complex = createMockIssue({
          body: "This requires a breaking change and involves race conditions and memory leaks",
        });

        const simple = createMockIssue({
          body: "Add a new option to the config",
        });

        const complexROI = service.calculateROI(complex);
        const simpleROI = service.calculateROI(simple);

        expect(complexROI.cost.complexitySignals).toBeGreaterThan(simpleROI.cost.complexitySignals);
      });
    });

    describe("edge cases", () => {
      it("should handle empty body", () => {
        const issue = createMockIssue({ body: "" });
        const roi = service.calculateROI(issue);

        expect(roi.roi).toBeGreaterThanOrEqual(0);
        expect(roi.roi).toBeLessThanOrEqual(100);
      });

      it("should handle null body", () => {
        const issue = createMockIssue({ body: null as unknown as string });
        const roi = service.calculateROI(issue);

        expect(roi.roi).toBeGreaterThanOrEqual(0);
        expect(roi.roi).toBeLessThanOrEqual(100);
      });

      it("should handle empty comments array", () => {
        const issue = createMockIssue({ comments: [] });
        const roi = service.calculateROI(issue);

        expect(roi.roi).toBeGreaterThanOrEqual(0);
      });

      it("should handle no context", () => {
        const issue = createMockIssue();
        const roi = service.calculateROI(issue);

        // Should use default repo popularity
        expect(roi.impact.repoPopularity).toBe(20);
      });
    });
  });

  describe("scoreIssue (legacy)", () => {
    const service = new SelectionService();

    it("should return a score with breakdown", () => {
      const issue = createMockIssue();
      const score = service.scoreIssue(issue);

      expect(score).toHaveProperty("total");
      expect(score).toHaveProperty("breakdown");
      expect(score.breakdown).toHaveProperty("complexity");
      expect(score.breakdown).toHaveProperty("engagement");
      expect(score.breakdown).toHaveProperty("recency");
      expect(score.breakdown).toHaveProperty("labels");
      expect(score.breakdown).toHaveProperty("clarity");
      expect(score.breakdown).toHaveProperty("codeScope");
      expect(score.breakdown).toHaveProperty("actionability");
    });
  });
});
