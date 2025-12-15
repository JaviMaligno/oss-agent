/**
 * GitHub Issue Source Provider
 *
 * Implements IssueSourceProvider for GitHub Issues.
 * Wraps the gh CLI for issue operations.
 */

import { spawn } from "node:child_process";
import type {
  IssueSourceProvider,
  IssueSourceCapabilities,
  IssueQueryOptions,
  IssueQueryResult,
  ProviderIssue,
  IssueTransitionOption,
} from "./types.js";
import type {
  ProviderInfo,
  ParsedIssueRef,
  ConnectionTestResult,
  ProviderConfig,
  WebhookConfig,
} from "../../../types/providers.js";
import type { Issue, IssueState, IssueComment } from "../../../types/issue.js";
import { logger } from "../../../infra/logger.js";

/**
 * GitHub issue as returned by gh CLI
 */
interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  createdAt: string;
  updatedAt: string;
  author: { login: string };
  comments: Array<{
    id: string;
    author: { login: string };
    body: string;
    createdAt: string;
  }>;
  assignees: Array<{ login: string }>;
}

export class GitHubIssueSourceProvider implements IssueSourceProvider {
  readonly info: ProviderInfo & { type: "github" } = {
    name: "GitHub Issues",
    type: "github",
    version: "1.0.0",
    baseUrl: "https://github.com",
  };

  readonly capabilities: IssueSourceCapabilities = {
    labels: true,
    assignment: true,
    priority: false, // GitHub doesn't have built-in priority
    estimation: false,
    sprints: false, // GitHub Projects has this but not core Issues
    customFields: false,
    linking: true, // Cross-references
    workflows: false, // Just open/closed
    externalPRLinking: true,
    webhooks: true,
  };

  private ghPath = "gh";

  async initialize(config: ProviderConfig): Promise<void> {
    if (config.settings.ghPath) {
      this.ghPath = config.settings.ghPath as string;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.gh(["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const result = await this.gh(["api", "user", "--jq", ".login"]);
      return {
        success: true,
        info: { user: result.trim() },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // === URL/ID Parsing ===

  canHandleUrl(url: string): boolean {
    return url.includes("github.com") && url.includes("/issues/");
  }

  parseIssueRef(ref: string): ParsedIssueRef | null {
    // Handle full URL: https://github.com/owner/repo/issues/123
    const urlMatch = ref.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (urlMatch?.[1] && urlMatch[2] && urlMatch[3]) {
      return {
        projectKey: `${urlMatch[1]}/${urlMatch[2]}`,
        issueNumber: parseInt(urlMatch[3], 10),
        url: ref,
      };
    }

    // Handle owner/repo#123 format
    const shortMatch = ref.match(/^([^/]+\/[^#]+)#(\d+)$/);
    if (shortMatch?.[1] && shortMatch[2]) {
      return {
        projectKey: shortMatch[1],
        issueNumber: parseInt(shortMatch[2], 10),
      };
    }

    // Handle #123 format (needs context)
    const numberMatch = ref.match(/^#?(\d+)$/);
    if (numberMatch?.[1]) {
      return {
        issueNumber: parseInt(numberMatch[1], 10),
      };
    }

    return null;
  }

  buildIssueUrl(projectKey: string, issueKey: string | number): string {
    return `https://github.com/${projectKey}/issues/${issueKey}`;
  }

  // === Issue Operations ===

  async getIssue(issueRef: string): Promise<ProviderIssue | null> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed?.projectKey || !parsed.issueNumber) {
      return null;
    }

    const [owner, repo] = parsed.projectKey.split("/");
    if (!owner || !repo) {
      return null;
    }

    try {
      const result = await this.gh([
        "issue",
        "view",
        String(parsed.issueNumber),
        "-R",
        parsed.projectKey,
        "--json",
        "number,title,body,state,labels,createdAt,updatedAt,author,comments,assignees",
      ]);

      const issue = JSON.parse(result) as GitHubIssue;
      return this.mapToProviderIssue(owner, repo, issue);
    } catch (error) {
      logger.debug(`Failed to get issue ${issueRef}: ${error}`);
      return null;
    }
  }

  async queryIssues(projectKey: string, options?: IssueQueryOptions): Promise<IssueQueryResult> {
    const [owner, repo] = projectKey.split("/");
    if (!owner || !repo) {
      return { issues: [], hasMore: false };
    }

    const args = [
      "issue",
      "list",
      "-R",
      projectKey,
      "--state",
      options?.state ?? "open",
      "--limit",
      String(options?.limit ?? 30),
      "--json",
      "number,title,body,state,labels,createdAt,updatedAt,author,comments,assignees",
    ];

    // Add label filter
    if (options?.labels && options.labels.length > 0) {
      for (const label of options.labels) {
        args.push("--label", label);
      }
    }

    // Add assignee filter
    if (options?.assignee !== undefined) {
      if (options.assignee === null) {
        // gh doesn't have a direct "unassigned" filter, we'll filter after
      } else {
        args.push("--assignee", options.assignee);
      }
    }

    try {
      const result = await this.gh(args);
      let issues = JSON.parse(result) as GitHubIssue[];

      // Post-filter for unassigned if requested
      if (options?.assignee === null) {
        issues = issues.filter((i) => i.assignees.length === 0);
      }

      // Post-filter for excluded labels
      if (options?.excludeLabels && options.excludeLabels.length > 0) {
        issues = issues.filter(
          (i) =>
            !i.labels.some((l) =>
              options.excludeLabels!.some((el) => l.name.toLowerCase() === el.toLowerCase())
            )
        );
      }

      const providerIssues = issues.map((i) => this.mapToProviderIssue(owner, repo, i));

      return {
        issues: providerIssues,
        hasMore: issues.length === (options?.limit ?? 30),
      };
    } catch (error) {
      logger.error(`Failed to query issues for ${projectKey}: ${error}`);
      return { issues: [], hasMore: false };
    }
  }

  async getLabels(projectKey: string): Promise<string[]> {
    try {
      const result = await this.gh([
        "label",
        "list",
        "-R",
        projectKey,
        "--json",
        "name",
        "--jq",
        ".[].name",
      ]);
      return result
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  async getComments(issueRef: string): Promise<IssueComment[]> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed?.projectKey || !parsed.issueNumber) {
      return [];
    }

    try {
      const result = await this.gh([
        "api",
        `repos/${parsed.projectKey}/issues/${parsed.issueNumber}/comments`,
        "--paginate",
      ]);

      const comments = JSON.parse(result) as Array<{
        id: number;
        user: { login: string };
        body: string;
        created_at: string;
      }>;

      return comments.map((c) => ({
        id: String(c.id),
        author: c.user.login,
        body: c.body,
        createdAt: new Date(c.created_at),
      }));
    } catch {
      return [];
    }
  }

  // === Issue Updates ===

  async addComment(issueRef: string, body: string): Promise<void> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed?.projectKey || !parsed.issueNumber) {
      throw new Error(`Invalid issue reference: ${issueRef}`);
    }

    await this.gh([
      "issue",
      "comment",
      String(parsed.issueNumber),
      "-R",
      parsed.projectKey,
      "--body",
      body,
    ]);
  }

  // GitHub doesn't have workflow transitions, just open/close
  async transitionIssue(issueRef: string, transitionId: string): Promise<boolean> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed?.projectKey || !parsed.issueNumber) {
      return false;
    }

    try {
      if (transitionId === "close") {
        await this.gh(["issue", "close", String(parsed.issueNumber), "-R", parsed.projectKey]);
      } else if (transitionId === "reopen") {
        await this.gh(["issue", "reopen", String(parsed.issueNumber), "-R", parsed.projectKey]);
      }
      return true;
    } catch {
      return false;
    }
  }

  async getTransitions(issueRef: string): Promise<IssueTransitionOption[]> {
    const issue = await this.getIssue(issueRef);
    if (!issue) {
      return [];
    }

    if (issue.status === "open") {
      return [{ id: "close", name: "Close issue", toStatus: "closed" }];
    } else {
      return [{ id: "reopen", name: "Reopen issue", toStatus: "open" }];
    }
  }

  async assignIssue(issueRef: string, assignee: string | null): Promise<void> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed?.projectKey || !parsed.issueNumber) {
      throw new Error(`Invalid issue reference: ${issueRef}`);
    }

    if (assignee) {
      await this.gh([
        "issue",
        "edit",
        String(parsed.issueNumber),
        "-R",
        parsed.projectKey,
        "--add-assignee",
        assignee,
      ]);
    } else {
      // To unassign, we'd need to know current assignees
      // For now, just log a warning
      logger.warn("Unassigning issues not fully supported for GitHub");
    }
  }

  async addLabels(issueRef: string, labels: string[]): Promise<void> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed?.projectKey || !parsed.issueNumber) {
      throw new Error(`Invalid issue reference: ${issueRef}`);
    }

    await this.gh([
      "issue",
      "edit",
      String(parsed.issueNumber),
      "-R",
      parsed.projectKey,
      "--add-label",
      labels.join(","),
    ]);
  }

  async removeLabels(issueRef: string, labels: string[]): Promise<void> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed?.projectKey || !parsed.issueNumber) {
      throw new Error(`Invalid issue reference: ${issueRef}`);
    }

    await this.gh([
      "issue",
      "edit",
      String(parsed.issueNumber),
      "-R",
      parsed.projectKey,
      "--remove-label",
      labels.join(","),
    ]);
  }

  // GitHub auto-links PRs that mention issues
  async linkToPR(issueRef: string, prUrl: string): Promise<void> {
    // Add a comment linking to the PR
    await this.addComment(issueRef, `Pull request created: ${prUrl}`);
  }

  // === Conversion ===

  toNormalizedIssue(providerIssue: ProviderIssue, projectId: string): Issue {
    return {
      id: providerIssue.externalId,
      url: providerIssue.url,
      number: providerIssue.number ?? 0,
      title: providerIssue.title,
      body: providerIssue.body,
      labels: providerIssue.labels,
      state: this.mapExternalStatusToState(providerIssue.status),
      author: providerIssue.author,
      assignee: providerIssue.assignees[0] ?? null,
      createdAt: providerIssue.createdAt,
      updatedAt: providerIssue.updatedAt,
      projectId,
      hasLinkedPR: false,
      linkedPRUrl: null,
    };
  }

  mapStateToExternalStatus(state: IssueState): string {
    switch (state) {
      case "merged":
      case "closed":
      case "abandoned":
        return "closed";
      default:
        return "open";
    }
  }

  mapExternalStatusToState(status: string): IssueState {
    return status.toLowerCase() === "closed" ? "closed" : "discovered";
  }

  getWebhookConfig(): WebhookConfig {
    return {
      path: "/webhooks/github/issues",
      events: ["issues", "issue_comment"],
    };
  }

  // === Private Helpers ===

  private mapToProviderIssue(owner: string, repo: string, issue: GitHubIssue): ProviderIssue {
    return {
      externalId: `${owner}/${repo}#${issue.number}`,
      url: `https://github.com/${owner}/${repo}/issues/${issue.number}`,
      key: `#${issue.number}`,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      status: issue.state === "OPEN" ? "open" : "closed",
      priority: "none", // GitHub doesn't have built-in priority
      labels: issue.labels.map((l) => l.name),
      createdAt: new Date(issue.createdAt),
      updatedAt: new Date(issue.updatedAt),
      author: issue.author.login,
      assignees: issue.assignees.map((a) => a.login),
      comments: issue.comments.map((c) => ({
        id: c.id,
        author: c.author.login,
        body: c.body,
        createdAt: new Date(c.createdAt),
      })),
      source: "github",
      repository: {
        owner,
        name: repo,
        fullName: `${owner}/${repo}`,
      },
      metadata: {},
    };
  }

  private gh(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ghPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

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
          reject(new Error(`gh ${args.join(" ")} failed: ${stderr || stdout}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn gh: ${err.message}`));
      });
    });
  }
}
