/**
 * Review Service - Automated PR review by second agent
 *
 * This service allows a second Claude Code agent to review PRs created by the first agent,
 * identify issues, auto-fix them, and post review comments.
 */

import { spawn } from "node:child_process";
import { Config } from "../../types/config.js";
import { AIProvider, QueryResult } from "../ai/types.js";
import { GitOperations } from "../git/git-operations.js";
import { PRService } from "../github/pr-service.js";
import { StateManager } from "../state/state-manager.js";
import { CICheckHandler, CIHandlerResult } from "./ci-handler.js";
import { logger } from "../../infra/logger.js";

export interface ReviewSuggestion {
  file: string;
  line?: number | undefined;
  severity: "critical" | "major" | "minor" | "nitpick";
  description: string;
  suggestedFix?: string | undefined;
  wasAutoFixed: boolean;
}

export interface ReviewResult {
  prUrl: string;
  approved: boolean;
  summary: string;
  suggestions: ReviewSuggestion[];
  blockers: string[];
  autoFixedCount: number;
  commentPosted: boolean;
  commitSha?: string | undefined;
  durationMs: number;
  ciResult?: CIHandlerResult | undefined;
}

export interface ReviewCIConfig {
  owner: string;
  repo: string;
  prNumber: number;
  worktreePath: string;
  branchName: string;
  pushRemote: string;
  maxIterations: number;
  waitForChecks: boolean;
  autoFix: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
  initialDelayMs: number;
  maxBudgetPerFix: number;
}

export interface ReviewOptions {
  prUrl: string;
  autoFix?: boolean | undefined;
  postComment?: boolean | undefined;
  // Whether to include approval/request-changes verdict in comment
  // Default false = comments only (no approval verdict)
  postApproval?: boolean | undefined;
  dryRun?: boolean | undefined;
  maxBudgetUsd?: number | undefined;
  mockMode?: boolean | undefined;
  // CI config for reviewer's CI check/fix loop
  ciConfig?: ReviewCIConfig | undefined;
}

export class ReviewService {
  private config: Config;
  private stateManager: StateManager;
  private gitOps: GitOperations;
  private aiProvider: AIProvider;
  private prService: PRService;

  constructor(
    config: Config,
    stateManager: StateManager,
    gitOps: GitOperations,
    aiProvider: AIProvider
  ) {
    this.config = config;
    this.stateManager = stateManager;
    this.gitOps = gitOps;
    this.aiProvider = aiProvider;
    this.prService = new PRService();
  }

  /**
   * Review a PR and optionally auto-fix issues
   */
  async review(options: ReviewOptions): Promise<ReviewResult> {
    const startTime = Date.now();

    logger.info(`Starting PR review: ${options.prUrl}`);

    // Mock mode for fast verification
    if (options.mockMode) {
      logger.warn("Running in MOCK MODE - Skipping AI analysis");
      logger.step(1, 5, "Simulating logic...");
      await new Promise((r) => setTimeout(r, 1000));
      logger.success("Mock review completed");

      const mockResult: ReviewResult = {
        prUrl: options.prUrl,
        approved: true,
        summary:
          "This is a MOCK review summary generated for verification purposes. The code looks correct and tests pass.",
        suggestions: [
          {
            file: "src/utils.ts",
            line: 10,
            severity: "minor",
            description: "Consider adding a JSDoc comment here (Mock Suggestion)",
            wasAutoFixed: false,
            suggestedFix: "/** Helper function */",
          },
        ],
        blockers: [],
        autoFixedCount: 0,
        commentPosted: false,
        durationMs: 1000,
      };

      // Allow mock post comment
      if (options.postComment && !options.dryRun) {
        logger.step(5, 5, "Posting mock review comment...");
        // Note: We still try to post the real comment to verify GitHub integration!
        try {
          const parsed = this.prService.parsePRUrl(options.prUrl);
          if (parsed) {
            await this.postPRComment(
              parsed.owner,
              parsed.repo,
              parsed.prNumber,
              this.buildReviewComment(mockResult, 0, options.postApproval ?? false)
            );
            mockResult.commentPosted = true;
            logger.success("Mock review comment posted");
          }
        } catch (e) {
          logger.warn(`Failed to post mock comment: ${e}`);
        }
      }
      return mockResult;
    }

    // Parse PR URL
    const parsed = this.prService.parsePRUrl(options.prUrl);
    if (!parsed) {
      return this.failResult(options.prUrl, "Invalid PR URL", startTime);
    }

    const { owner, repo, prNumber } = parsed;

    // Fetch PR data and diff
    logger.step(1, 5, "Fetching PR details and diff...");
    const { pr, checks } = await this.prService.getPRFeedback(owner, repo, prNumber);

    // Get full diff via gh CLI
    const diff = await this.getPRDiff(owner, repo, prNumber);

    // Find work record if we have one
    const workRecord = this.stateManager.getWorkRecordByPRUrl(options.prUrl);

    let worktreePath: string | undefined;
    if (workRecord) {
      worktreePath = workRecord.worktreePath;
    }

    // Build review prompt
    logger.step(2, 5, "Analyzing changes with AI...");
    const prompt = this.buildReviewPrompt(pr, diff, checks, options.autoFix ?? false);

    // Execute AI query
    let queryResult: QueryResult;
    try {
      queryResult = await this.aiProvider.query(prompt, {
        cwd: worktreePath ?? process.cwd(),
        ...(this.config.ai.model && { model: this.config.ai.model }),
        maxTurns: 30,
        ...(options.maxBudgetUsd !== undefined && { maxBudgetUsd: options.maxBudgetUsd }),
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return this.failResult(options.prUrl, `AI review failed: ${errorMsg}`, startTime);
    }

    if (!queryResult.success) {
      return this.failResult(options.prUrl, queryResult.error ?? "AI review failed", startTime);
    }

    // Parse review results from AI output
    logger.step(3, 5, "Parsing review results...");
    const reviewData = this.parseReviewOutput(queryResult.output);

    // If auto-fix was enabled and we have a worktree, check for changes
    let autoFixedCount = 0;
    let commitSha: string | undefined;

    if (options.autoFix && worktreePath && !options.dryRun) {
      logger.step(4, 5, "Checking for auto-fixes...");
      const hasChanges = await this.gitOps.hasUncommittedChanges(worktreePath);
      if (hasChanges) {
        const fixedSuggestions = reviewData.suggestions.filter((s) => s.wasAutoFixed);
        autoFixedCount = fixedSuggestions.length;

        if (autoFixedCount > 0) {
          const commitMessage = this.buildFixCommitMessage(fixedSuggestions);
          await this.gitOps.commit(worktreePath, commitMessage);
          // Pushing fix
          // Note: We use the same retry logic as IssueProcessor for robustness
          try {
            await this.gitOps.push(worktreePath, pr.headBranch);
          } catch {
            logger.warn(`Auto-fix push failed, retrying with skip verification...`);
            await this.gitOps.push(worktreePath, pr.headBranch, { skipVerification: true });
          }

          // Get new commit SHA
          const newSha = await this.gitOps.getHeadSha(worktreePath);
          commitSha = newSha;
          logger.success(`Auto-fixed ${autoFixedCount} issue(s) and pushed to branch`);
        }
      }
    }

    // Post review comment if enabled
    let commentPosted = false;
    if (options.postComment && !options.dryRun) {
      logger.step(5, 6, "Posting review comment...");
      const comment = this.buildReviewComment(
        reviewData,
        autoFixedCount,
        options.postApproval ?? false
      );
      await this.postPRComment(owner, repo, prNumber, comment);
      commentPosted = true;
      logger.success("Review comment posted");
    }

    // Run CI check/fix loop if ciConfig is provided
    let ciResult: CIHandlerResult | undefined;
    if (options.ciConfig && !options.dryRun) {
      logger.step(6, 6, "Running CI checks...");
      try {
        const ciHandler = new CICheckHandler(this.prService, this.gitOps, this.aiProvider);

        ciResult = await ciHandler.handleChecks(
          options.ciConfig.owner,
          options.ciConfig.repo,
          options.ciConfig.prNumber,
          options.ciConfig.worktreePath,
          options.ciConfig.branchName,
          {
            maxIterations: options.ciConfig.maxIterations,
            waitForChecks: options.ciConfig.waitForChecks,
            autoFix: options.ciConfig.autoFix,
            timeoutMs: options.ciConfig.timeoutMs,
            pollIntervalMs: options.ciConfig.pollIntervalMs,
            initialDelayMs: options.ciConfig.initialDelayMs,
            maxBudgetPerFix: options.ciConfig.maxBudgetPerFix,
            pushRemote: options.ciConfig.pushRemote,
            maxTurnsPerFix: 50,
          }
        );

        if (ciResult.finalStatus === "success") {
          logger.success("All CI checks passed after reviewer phase!");
        } else if (ciResult.finalStatus === "no_checks") {
          logger.info("No CI checks configured for this repository");
        } else {
          logger.warn(`CI handling finished with status: ${ciResult.finalStatus}`);
          logger.info(ciResult.summary);
        }
      } catch (error) {
        logger.error(`Reviewer CI check handling failed: ${error}`);
      }
    }

    const durationMs = Date.now() - startTime;

    // Determine if approved
    const approved = reviewData.blockers.length === 0;

    logger.success(`Review completed in ${(durationMs / 1000).toFixed(1)}s`);
    if (approved) {
      logger.info("✓ PR approved - no blocking issues found");
    } else {
      logger.warn(`✗ PR has ${reviewData.blockers.length} blocking issue(s)`);
    }

    return {
      prUrl: options.prUrl,
      approved,
      summary: reviewData.summary,
      suggestions: reviewData.suggestions,
      blockers: reviewData.blockers,
      autoFixedCount,
      commentPosted,
      commitSha,
      durationMs,
      ciResult,
    };
  }

  /**
   * Get PR diff via gh CLI
   */
  private async getPRDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("gh", ["pr", "diff", String(prNumber), "--repo", `${owner}/${repo}`]);

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`gh pr diff failed: ${stderr}`));
        }
      });
    });
  }

  /**
   * Post a comment on a PR
   */
  private async postPRComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("gh", [
        "pr",
        "comment",
        String(prNumber),
        "--repo",
        `${owner}/${repo}`,
        "--body",
        body,
      ]);

      let stderr = "";

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`gh pr comment failed: ${stderr}`));
        }
      });
    });
  }

  /**
   * Build the review prompt for AI
   */
  private buildReviewPrompt(
    pr: { title: string; body: string; headBranch: string },
    diff: string,
    checks: { name: string; status: string; conclusion: string | null }[],
    autoFix: boolean
  ): string {
    const failedChecks = checks.filter((c) => c.conclusion === "failure" || c.status === "failure");

    let prompt = `You are reviewing a pull request as a second opinion before human review.

## PR Information
**Title:** ${pr.title}
**Branch:** ${pr.headBranch}

**Description:**
${pr.body || "No description provided."}

## Diff
\`\`\`diff
${diff.slice(0, 50000)}
\`\`\`
${diff.length > 50000 ? "\n[Diff truncated - there are more changes not shown]\n" : ""}
`;

    if (failedChecks.length > 0) {
      prompt += `\n## Failed CI Checks\n`;
      for (const check of failedChecks) {
        prompt += `- ${check.name}: ${check.conclusion ?? check.status}\n`;
      }
    }

    prompt += `
## Your Task

Review this PR for:
1. **Logic errors** - Bugs, incorrect implementations, edge cases
2. **Code quality** - Readability, maintainability, best practices
3. **Security issues** - Vulnerabilities, unsafe patterns
4. **Test coverage** - Missing tests for new functionality
5. **Documentation** - Missing or outdated comments/docs
6. **Debug artifacts** - Files or code that should not be committed (see below)
7. **Unrelated changes** - Modifications not directly related to the PR's purpose

## CRITICAL: Debug Artifacts Check (BLOCKER if found)

Look carefully in the diff for:

**Debug/Temp Files** (these should be DELETED, not committed):
- Files named: \`debug.ts\`, \`debug-*.ts\`, \`*.debug.ts\`, \`*.debug.js\`
- Files named: \`temp.ts\`, \`tmp.ts\`, \`scratch.ts\`, \`play.ts\`
- Files named: \`test-*.ts\` that are NOT in a proper tests/test/__tests__ directory
- Any file that appears to be created solely for debugging or experimentation

**Debug Code** (should be removed):
- \`console.log\` statements that appear to be debugging (not intentional output)
- Commented-out code blocks that were added by this PR
- TODO/FIXME comments added for debugging purposes

**Unrelated Changes**:
- Modifications to files that have no clear connection to the PR's stated purpose
- Formatting-only changes to unrelated files
- Changes to playground/example files not needed for the fix

If you find ANY debug artifacts, mark them as BLOCKER severity. These must be removed before merge.

For each issue found, categorize as:
- **BLOCKER**: Must be fixed before merge (bugs, security issues, debug artifacts)
- **MAJOR**: Should be fixed (significant quality issues)
- **MINOR**: Nice to fix (style, minor improvements)
- **NITPICK**: Optional suggestions

`;

    if (autoFix) {
      prompt += `
## Auto-Fix Instructions

You have permission to auto-fix issues. For any issue you can fix:
1. Make the fix directly in the code
2. Mark the suggestion with "AUTO-FIXED: true" in your output

**PRIORITY auto-fixes (do these first):**
- DELETE any debug/temp files (debug.ts, debug-*.ts, temp.ts, play.ts, etc.)
- REVERT unrelated file changes using git checkout
- Remove debug console.log statements

Only auto-fix clear issues. Do NOT auto-fix:
- Subjective style preferences
- Major architectural changes
- Changes that need human judgment
`;
    }

    prompt += `
## Output Format

Provide your review in the following format:

### SUMMARY
[One paragraph summary of the PR quality and your recommendation]

### BLOCKERS
[List each blocking issue, or "None" if no blockers]

### SUGGESTIONS
For each suggestion:
SUGGESTION:
- FILE: [filename]
- LINE: [line number or "N/A"]
- SEVERITY: [BLOCKER|MAJOR|MINOR|NITPICK]
- DESCRIPTION: [what's wrong]
- FIX: [suggested fix]
${autoFix ? "- AUTO-FIXED: [true|false]" : ""}

### VERDICT
[APPROVE or REQUEST_CHANGES]
`;

    return prompt;
  }

  /**
   * Parse AI review output into structured data
   */
  private parseReviewOutput(output: string): {
    summary: string;
    blockers: string[];
    suggestions: ReviewSuggestion[];
  } {
    const suggestions: ReviewSuggestion[] = [];
    const blockers: string[] = [];
    let summary = "";

    // Extract summary - try multiple formats
    const summaryMatch = output.match(/### SUMMARY\s*\n([\s\S]*?)(?=### |$)/i);
    if (summaryMatch) {
      summary = summaryMatch[1]?.trim() ?? "";
    }

    // If no SUMMARY section, try to get text after VERDICT
    if (!summary) {
      const verdictMatch = output.match(
        /### VERDICT\s*\n\s*(?:APPROVE|REQUEST_CHANGES)\s*\n([\s\S]*?)(?=---|$)/i
      );
      if (verdictMatch) {
        summary = verdictMatch[1]?.trim() ?? "";
      }
    }

    // Still no summary? Use last substantial paragraph
    if (!summary) {
      const paragraphs = output.split(/\n\n+/).filter((p) => p.trim().length > 50);
      if (paragraphs.length > 0) {
        summary = paragraphs[paragraphs.length - 1]?.trim() ?? "";
      }
    }

    // Extract blockers from ### BLOCKERS section
    const blockersMatch = output.match(/### BLOCKERS\s*\n([\s\S]*?)(?=### |$)/i);
    if (blockersMatch) {
      const blockersText = blockersMatch[1]?.trim() ?? "";
      if (!blockersText.toLowerCase().includes("none")) {
        const lines = blockersText.split("\n").filter((l) => l.trim().startsWith("-"));
        for (const line of lines) {
          blockers.push(line.replace(/^-\s*/, "").trim());
        }
      }
    }

    // Also check verdict for REQUEST_CHANGES - if present, there are blockers
    const verdictLineMatch = output.match(/### VERDICT\s*\n\s*(APPROVE|REQUEST_CHANGES)/i);
    if (verdictLineMatch) {
      const verdict = verdictLineMatch[1]?.toUpperCase();
      if (verdict === "REQUEST_CHANGES" && blockers.length === 0) {
        // Extract reason from text after verdict
        const reasonMatch = output.match(
          /### VERDICT\s*\n\s*REQUEST_CHANGES\s*\n([\s\S]*?)(?=---|$)/i
        );
        if (reasonMatch) {
          const reason = reasonMatch[1]?.trim();
          if (reason) {
            // Take first sentence or first 200 chars as blocker description
            const firstSentence = reason.match(/^[^.!?]+[.!?]/)?.[0] ?? reason.slice(0, 200);
            blockers.push(firstSentence.trim());
          }
        }
      }
    }

    // Extract suggestions - try multiple formats
    // Format 1: ### SUGGESTIONS section with SUGGESTION: blocks
    const suggestionsSection = output.match(/### SUGGESTIONS\s*\n([\s\S]*?)(?=### |$)/i);
    if (suggestionsSection) {
      this.parseSuggestionBlocks(suggestionsSection[1] ?? "", suggestions);
    }

    // Format 2: **SUGGESTION:** or SUGGESTION: anywhere in output
    if (suggestions.length === 0) {
      this.parseSuggestionBlocks(output, suggestions);
    }

    return { summary, blockers, suggestions };
  }

  /**
   * Parse suggestion blocks from text
   */
  private parseSuggestionBlocks(text: string, suggestions: ReviewSuggestion[]): void {
    // Split by SUGGESTION: or **SUGGESTION:**
    const suggestionBlocks = text.split(/\*?\*?SUGGESTION:?\*?\*?\s*\n/i);

    for (const block of suggestionBlocks) {
      if (!block.trim()) continue;

      // Match fields with - prefix or without
      const fileMatch = block.match(/-?\s*FILE:\s*(.+)/i);
      const lineMatch = block.match(/-?\s*LINE:\s*(.+)/i);
      const severityMatch = block.match(/-?\s*SEVERITY:\s*(.+)/i);
      const descMatch = block.match(/-?\s*DESCRIPTION:\s*(.+)/i);
      const fixMatch = block.match(/-?\s*FIX:\s*(.+)/i);
      const autoFixedMatch = block.match(/-?\s*AUTO-FIXED:\s*(true|false)/i);

      if (fileMatch && severityMatch && descMatch) {
        const severityText = severityMatch[1]?.toUpperCase().trim() ?? "MINOR";
        let severity: ReviewSuggestion["severity"] = "minor";
        if (severityText === "BLOCKER" || severityText === "CRITICAL") severity = "critical";
        else if (severityText === "MAJOR") severity = "major";
        else if (severityText === "NITPICK") severity = "nitpick";

        const lineText = lineMatch?.[1]?.trim();
        const lineNum = lineText && lineText !== "N/A" ? parseInt(lineText, 10) : undefined;

        suggestions.push({
          file: fileMatch[1]?.trim() ?? "unknown",
          line: isNaN(lineNum ?? NaN) ? undefined : lineNum,
          severity,
          description: descMatch[1]?.trim() ?? "",
          suggestedFix: fixMatch?.[1]?.trim(),
          wasAutoFixed: autoFixedMatch?.[1]?.toLowerCase() === "true",
        });
      }
    }
  }

  /**
   * Build commit message for auto-fixes
   */
  private buildFixCommitMessage(suggestions: ReviewSuggestion[]): string {
    const issues = suggestions.map((s) => `- ${s.description}`).join("\n");
    return `fix: address review suggestions

Auto-fixed issues:
${issues}

---
Changes prepared by automated PR review`;
  }

  /**
   * Build review comment to post on PR
   */
  private buildReviewComment(
    reviewData: { summary: string; blockers: string[]; suggestions: ReviewSuggestion[] },
    autoFixedCount: number,
    postApproval: boolean
  ): string {
    let comment = `## 🤖 Automated PR Review\n\n`;
    comment += `${reviewData.summary}\n\n`;

    if (autoFixedCount > 0) {
      comment += `### ✅ Auto-Fixed Issues (${autoFixedCount})\n`;
      comment += `The following issues were automatically fixed and committed:\n`;
      for (const s of reviewData.suggestions.filter((s) => s.wasAutoFixed)) {
        comment += `- **${s.file}**: ${s.description}\n`;
      }
      comment += `\n`;
    }

    if (reviewData.blockers.length > 0) {
      comment += `### 🚫 Blocking Issues\n`;
      for (const blocker of reviewData.blockers) {
        comment += `- ${blocker}\n`;
      }
      comment += `\n`;
    }

    const unfixedSuggestions = reviewData.suggestions.filter((s) => !s.wasAutoFixed);
    if (unfixedSuggestions.length > 0) {
      comment += `### 💡 Suggestions\n`;
      for (const s of unfixedSuggestions) {
        const severityEmoji =
          s.severity === "critical"
            ? "🔴"
            : s.severity === "major"
              ? "🟠"
              : s.severity === "minor"
                ? "🟡"
                : "⚪";
        comment += `- ${severityEmoji} **${s.file}${s.line ? `:${s.line}` : ""}**: ${s.description}\n`;
        if (s.suggestedFix) {
          comment += `  - Suggested fix: ${s.suggestedFix}\n`;
        }
      }
    }

    // Only include verdict if postApproval is enabled
    if (postApproval) {
      if (reviewData.blockers.length === 0) {
        comment += `\n---\n✅ **Verdict: Approved** - No blocking issues found.\n`;
      } else {
        comment += `\n---\n⚠️ **Verdict: Changes Requested** - Please address the blocking issues above.\n`;
      }
    }

    comment += `\n*This review was performed by an automated agent.*`;

    return comment;
  }

  /**
   * Create a failure result
   */
  private failResult(prUrl: string, error: string, startTime: number): ReviewResult {
    logger.error(error);
    return {
      prUrl,
      approved: false,
      summary: error,
      suggestions: [],
      blockers: [error],
      autoFixedCount: 0,
      commentPosted: false,
      durationMs: Date.now() - startTime,
    };
  }
}
