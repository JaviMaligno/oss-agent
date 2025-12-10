import { describe, it, expect } from "vitest";
import { FeedbackParser } from "../../src/core/github/feedback-parser.js";
import { PullRequest, PRReview, PRComment, PRCheck } from "../../src/types/pr.js";

describe("FeedbackParser", () => {
  const parser = new FeedbackParser();

  // Helper to create test data
  const createPR = (overrides: Partial<PullRequest> = {}): PullRequest => ({
    id: "owner/repo#1",
    url: "https://github.com/owner/repo/pull/1",
    number: 1,
    title: "Test PR",
    body: "Test body",
    state: "open",
    isDraft: false,
    mergeable: true,
    headBranch: "feature",
    baseBranch: "main",
    headSha: "abc123",
    author: "testuser",
    createdAt: new Date(),
    updatedAt: new Date(),
    linkedIssueUrl: null,
    commentCount: 0,
    reviewCommentCount: 0,
    checksPass: true,
    ...overrides,
  });

  const createReview = (overrides: Partial<PRReview> = {}): PRReview => ({
    id: "review-1",
    prId: "owner/repo#1",
    state: "commented",
    author: "reviewer",
    body: "Test review",
    submittedAt: new Date(),
    commitSha: "abc123",
    ...overrides,
  });

  const createComment = (overrides: Partial<PRComment> = {}): PRComment => ({
    id: "comment-1",
    prId: "owner/repo#1",
    author: "commenter",
    body: "Test comment",
    createdAt: new Date(),
    updatedAt: new Date(),
    isReviewComment: false,
    path: null,
    line: null,
    side: null,
    originalLine: null,
    inReplyToId: null,
    ...overrides,
  });

  const createCheck = (overrides: Partial<PRCheck> = {}): PRCheck => ({
    id: "check-1",
    name: "CI",
    status: "success",
    conclusion: "success",
    detailsUrl: null,
    startedAt: new Date(),
    completedAt: new Date(),
    outputSummary: null,
    outputText: null,
    ...overrides,
  });

  describe("parse", () => {
    it("should return empty actionable items for LGTM comments", () => {
      const pr = createPR();
      const comments = [createComment({ body: "LGTM!" })];

      const result = parser.parse(pr, [], comments, []);

      expect(result.actionableItems).toHaveLength(0);
    });

    it("should detect bug fix requests", () => {
      const pr = createPR();
      const comments = [createComment({ body: "This is broken when the input is null" })];

      const result = parser.parse(pr, [], comments, []);

      expect(result.actionableItems).toHaveLength(1);
      expect(result.actionableItems[0]?.type).toBe("bug_fix");
    });

    it("should detect security concerns with high priority", () => {
      const pr = createPR();
      const comments = [
        createComment({ body: "This has a security vulnerability - SQL injection possible" }),
      ];

      const result = parser.parse(pr, [], comments, []);

      expect(result.actionableItems).toHaveLength(1);
      expect(result.actionableItems[0]?.type).toBe("security");
      expect(result.actionableItems[0]?.priority).toBe(1);
    });

    it("should detect code change requests", () => {
      const pr = createPR();
      const comments = [
        createComment({ body: "Please change this to use a Map instead of object" }),
      ];

      const result = parser.parse(pr, [], comments, []);

      expect(result.actionableItems).toHaveLength(1);
      expect(result.actionableItems[0]?.type).toBe("code_change");
    });

    it("should detect test requests", () => {
      const pr = createPR();
      const comments = [createComment({ body: "Missing test coverage here" })];

      const result = parser.parse(pr, [], comments, []);

      expect(result.actionableItems).toHaveLength(1);
      expect(result.actionableItems[0]?.type).toBe("test");
    });

    it("should extract feedback from changes_requested reviews", () => {
      const pr = createPR();
      const reviews = [
        createReview({
          state: "changes_requested",
          body: "Please fix the error handling - this is broken when input is null",
        }),
      ];

      const result = parser.parse(pr, reviews, [], []);

      // changes_requested reviews with substantial body are actionable
      expect(result.actionableItems.length).toBeGreaterThanOrEqual(1);
      expect(result.needsAttention).toBe(true);
    });

    it("should detect CI failures", () => {
      const pr = createPR({ checksPass: false });
      const checks = [
        createCheck({
          name: "Tests",
          status: "failure",
          conclusion: "failure",
        }),
      ];

      const result = parser.parse(pr, [], [], checks);

      expect(result.actionableItems).toHaveLength(1);
      expect(result.actionableItems[0]?.type).toBe("ci_failure");
      expect(result.actionableItems[0]?.priority).toBe(1);
      expect(result.needsAttention).toBe(true);
    });

    it("should ignore bot authors", () => {
      const parser2 = new FeedbackParser({ ignoreAuthors: ["dependabot[bot]"] });
      const pr = createPR();
      const comments = [createComment({ author: "dependabot[bot]", body: "Please update this" })];

      const result = parser2.parse(pr, [], comments, []);

      expect(result.actionableItems).toHaveLength(0);
    });

    it("should skip reply comments", () => {
      const pr = createPR();
      const comments = [
        createComment({ id: "1", body: "Please fix this bug" }),
        createComment({ id: "2", body: "I agree", inReplyToId: "1" }),
      ];

      const result = parser.parse(pr, [], comments, []);

      // Only the original comment should be actionable
      expect(result.actionableItems).toHaveLength(1);
    });

    it("should include file path for inline comments", () => {
      const pr = createPR();
      const comments = [
        createComment({
          body: "This should use a constant instead",
          isReviewComment: true,
          path: "src/utils.ts",
          line: 42,
        }),
      ];

      const result = parser.parse(pr, [], comments, []);

      expect(result.actionableItems).toHaveLength(1);
      expect(result.actionableItems[0]?.filePath).toBe("src/utils.ts");
      expect(result.actionableItems[0]?.lineNumber).toBe(42);
    });
  });

  describe("buildSummary", () => {
    it("should summarize PR with approvals", () => {
      const pr = createPR();
      const reviews = [createReview({ state: "approved" })];

      const result = parser.parse(pr, reviews, [], []);

      expect(result.summary).toContain("1 approval");
    });

    it("should summarize PR with changes requested", () => {
      const pr = createPR();
      const reviews = [createReview({ state: "changes_requested", body: "Fix this" })];

      const result = parser.parse(pr, reviews, [], []);

      expect(result.summary).toContain("requested changes");
    });

    it("should indicate merge conflicts", () => {
      const pr = createPR({ mergeable: false });

      const result = parser.parse(pr, [], [], []);

      expect(result.summary).toContain("merge conflicts");
    });
  });

  describe("formatForPrompt", () => {
    it("should format feedback items for AI", () => {
      const pr = createPR();
      const comments = [
        createComment({
          body: "Please fix this security issue",
          path: "src/auth.ts",
          line: 10,
          isReviewComment: true,
        }),
      ];

      const result = parser.parse(pr, [], comments, []);
      const formatted = parser.formatForPrompt(result.actionableItems);

      expect(formatted).toContain("src/auth.ts");
      expect(formatted).toContain("security");
    });

    it("should return message for empty feedback", () => {
      const formatted = parser.formatForPrompt([]);

      expect(formatted).toContain("No actionable feedback");
    });
  });

  describe("groupByFile", () => {
    it("should group feedback by file path", () => {
      const pr = createPR();
      const comments = [
        createComment({
          body: "Please fix this bug here",
          path: "src/a.ts",
          isReviewComment: true,
        }),
        createComment({ body: "And this is broken too", path: "src/a.ts", isReviewComment: true }),
        createComment({ body: "Also fix this bug", path: "src/b.ts", isReviewComment: true }),
      ];

      const result = parser.parse(pr, [], comments, []);
      const grouped = parser.groupByFile(result.actionableItems);

      // Check that we have items grouped by file
      const fileAItems = grouped.get("src/a.ts") ?? [];
      const fileBItems = grouped.get("src/b.ts") ?? [];

      expect(fileAItems.length).toBeGreaterThanOrEqual(1);
      expect(fileBItems.length).toBeGreaterThanOrEqual(1);
    });
  });
});
