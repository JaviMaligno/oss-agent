/**
 * GitLab Repository Provider
 *
 * Implements RepositoryProvider interface for GitLab.
 * Uses the glab CLI (GitLab's official CLI) when available,
 * otherwise falls back to direct API calls.
 */

import { spawn } from "node:child_process";
import type {
  RepositoryProvider,
  RepositoryCapabilities,
  RepoInfo,
  PermissionCheck,
  ForkResult,
  CreatePROptions,
  CreatePRResult,
  UpdatePROptions,
  PRFeedbackData,
} from "./types.js";
import type { ProviderInfo, ParsedUrl, ConnectionTestResult } from "../../../types/providers.js";
import type { PullRequest, PRReview, PRComment, PRCheck } from "../../../types/pr.js";
import type { Project } from "../../../types/project.js";
import type { Config, GitLabConfig } from "../../../types/config.js";
import { logger } from "../../../infra/logger.js";

export class GitLabRepositoryProvider implements RepositoryProvider {
  readonly info: ProviderInfo & { type: "gitlab" };

  readonly capabilities: RepositoryCapabilities = {
    forking: true,
    draftPRs: true,
    reviews: true,
    inlineComments: true,
    statusChecks: true,
    autoMerge: true,
    branchProtection: true,
    codeOwners: true,
    prTerminology: "merge_request",
  };

  private readonly gitlabHost: string;
  private readonly gitlabBaseUrl: string;
  private readonly token: string | undefined;
  private readonly preferCli: boolean;
  private glabPath: string = "glab";

  constructor(
    protected config: Config,
    gitlabConfig?: GitLabConfig
  ) {
    const baseUrl = gitlabConfig?.baseUrl ?? "https://gitlab.com";
    const url = new globalThis.URL(baseUrl);

    this.gitlabHost = url.host;
    this.gitlabBaseUrl = baseUrl;
    this.token = gitlabConfig?.token ?? process.env["GITLAB_TOKEN"];
    this.preferCli = gitlabConfig?.preferCli ?? true;

    this.info = {
      name: this.gitlabHost === "gitlab.com" ? "GitLab" : `GitLab (${this.gitlabHost})`,
      type: "gitlab",
      version: "1.0.0",
      baseUrl,
    };
  }

  // === Availability ===

  async isAvailable(): Promise<boolean> {
    if (this.preferCli) {
      try {
        await this.runGlab(["--version"]);
        return true;
      } catch {
        // glab not available, check for token
        return !!this.token;
      }
    }
    return !!this.token;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const user = await this.getCurrentUser();
      return {
        success: true,
        info: {
          user,
          host: this.gitlabHost,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // === URL Handling ===

  canHandleUrl(url: string): boolean {
    try {
      const parsed = new globalThis.URL(url);
      return parsed.host === this.gitlabHost;
    } catch {
      return false;
    }
  }

  parseUrl(url: string): ParsedUrl | null {
    if (!this.canHandleUrl(url)) {
      return null;
    }

    try {
      const parsed = new globalThis.URL(url);
      const path = parsed.pathname;

      // GitLab paths can include groups and subgroups
      // e.g., /group/subgroup/project/-/merge_requests/123
      // or /user/project/-/issues/123
      // or /group/project

      // First, check for MR or issue
      const mrMatch = path.match(/^\/(.+?)\/-\/merge_requests\/(\d+)/);
      if (mrMatch?.[1] && mrMatch[2]) {
        const projectPath = mrMatch[1];
        const parts = projectPath.split("/");
        const repo = parts.pop()!;
        const owner = parts.join("/");
        return {
          provider: "gitlab",
          host: this.gitlabHost,
          owner,
          repo,
          resourceType: "mr",
          resourceId: parseInt(mrMatch[2], 10),
        };
      }

      const issueMatch = path.match(/^\/(.+?)\/-\/issues\/(\d+)/);
      if (issueMatch?.[1] && issueMatch[2]) {
        const projectPath = issueMatch[1];
        const parts = projectPath.split("/");
        const repo = parts.pop()!;
        const owner = parts.join("/");
        return {
          provider: "gitlab",
          host: this.gitlabHost,
          owner,
          repo,
          resourceType: "issue",
          resourceId: parseInt(issueMatch[2], 10),
        };
      }

      // Plain project path
      const projectMatch = path.match(/^\/(.+?)(?:\.git)?$/);
      if (projectMatch?.[1]) {
        const projectPath = projectMatch[1].replace(/\/-$/, ""); // Remove trailing /-
        const parts = projectPath.split("/").filter(Boolean);
        if (parts.length >= 2) {
          const repo = parts.pop()!;
          const owner = parts.join("/");
          return {
            provider: "gitlab",
            host: this.gitlabHost,
            owner,
            repo,
          };
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  buildUrl(parsed: Omit<ParsedUrl, "provider" | "host">): string {
    let url = `${this.gitlabBaseUrl}/${parsed.owner}/${parsed.repo}`;
    if (parsed.resourceType === "mr" && parsed.resourceId) {
      url += `/-/merge_requests/${parsed.resourceId}`;
    } else if (parsed.resourceType === "issue" && parsed.resourceId) {
      url += `/-/issues/${parsed.resourceId}`;
    }
    return url;
  }

  // === Repository Operations ===

  async getRepoInfo(owner: string, repo: string): Promise<RepoInfo> {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const data = await this.apiCall<{
      id: number;
      name: string;
      path_with_namespace: string;
      web_url: string;
      http_url_to_repo: string;
      ssh_url_to_repo: string;
      default_branch: string;
      visibility: string;
      forked_from_project?: {
        path_with_namespace: string;
      };
      archived: boolean;
    }>(`projects/${projectPath}`);

    const result: RepoInfo = {
      owner,
      name: data.name,
      fullName: data.path_with_namespace,
      url: data.web_url,
      cloneUrl: data.http_url_to_repo,
      sshUrl: data.ssh_url_to_repo,
      defaultBranch: data.default_branch,
      isPrivate: data.visibility !== "public",
      isFork: !!data.forked_from_project,
      isArchived: data.archived,
    };

    if (data.forked_from_project) {
      const parentPath = data.forked_from_project.path_with_namespace;
      const parentParts = parentPath.split("/");
      result.parent = {
        owner: parentParts.slice(0, -1).join("/"),
        name: parentParts[parentParts.length - 1]!,
        fullName: parentPath,
      };
    }

    return result;
  }

  async checkPermissions(owner: string, repo: string): Promise<PermissionCheck> {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const data = await this.apiCall<{
      permissions?: {
        project_access?: { access_level: number };
        group_access?: { access_level: number };
      };
    }>(`projects/${projectPath}`);

    const projectAccess = data.permissions?.project_access?.access_level ?? 0;
    const groupAccess = data.permissions?.group_access?.access_level ?? 0;
    const maxAccess = Math.max(projectAccess, groupAccess);

    // GitLab access levels: 10=Guest, 20=Reporter, 30=Developer, 40=Maintainer, 50=Owner
    return {
      canPush: maxAccess >= 30, // Developer+
      canCreatePR: maxAccess >= 30, // Developer+
      canMerge: maxAccess >= 40, // Maintainer+
      isMember: maxAccess >= 20, // Reporter+
      isOwner: maxAccess >= 50,
      isAdmin: maxAccess >= 40, // Maintainer+
    };
  }

  async getCurrentUser(): Promise<string> {
    if (this.preferCli) {
      try {
        const output = await this.runGlab(["auth", "status"]);
        const match = output.match(/Logged in to .+ as (\S+)/);
        if (match?.[1]) {
          return match[1];
        }
      } catch {
        // Fall through to API
      }
    }

    const data = await this.apiCall<{ username: string }>("user");
    return data.username;
  }

  async forkRepo(owner: string, repo: string): Promise<ForkResult> {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);

    // Check if fork already exists
    const currentUser = await this.getCurrentUser();
    try {
      const existingFork = await this.getRepoInfo(currentUser, repo);
      if (existingFork.isFork) {
        return {
          fork: existingFork,
          created: false,
        };
      }
    } catch {
      // Fork doesn't exist, create it
    }

    const data = await this.apiCall<{
      id: number;
      name: string;
      path_with_namespace: string;
      web_url: string;
      http_url_to_repo: string;
      ssh_url_to_repo: string;
      default_branch: string;
      visibility: string;
      forked_from_project?: {
        path_with_namespace: string;
      };
    }>(`projects/${projectPath}/fork`, {
      method: "POST",
    });

    const fork: RepoInfo = {
      owner: currentUser,
      name: data.name,
      fullName: data.path_with_namespace,
      url: data.web_url,
      cloneUrl: data.http_url_to_repo,
      sshUrl: data.ssh_url_to_repo,
      defaultBranch: data.default_branch,
      isPrivate: data.visibility !== "public",
      isFork: true,
      isArchived: false,
    };

    if (data.forked_from_project) {
      fork.parent = {
        owner,
        name: repo,
        fullName: data.forked_from_project.path_with_namespace,
      };
    }

    return {
      fork,
      created: true,
    };
  }

  async syncFork(_owner: string, _repo: string, _branch?: string): Promise<void> {
    // GitLab doesn't have a direct "sync fork" feature like GitHub
    // This would need to be done via git commands
    logger.warn("GitLab fork sync not implemented - use git pull from upstream manually");
  }

  async getProject(owner: string, repo: string): Promise<Project | null> {
    try {
      const projectPath = encodeURIComponent(`${owner}/${repo}`);
      const data = await this.apiCall<{
        id: number;
        name: string;
        path_with_namespace: string;
        description: string | null;
        web_url: string;
        star_count: number;
        forks_count: number;
        open_issues_count: number;
        topics: string[];
        default_branch: string;
        last_activity_at: string;
      }>(`projects/${projectPath}`);

      // Get languages
      const languages = await this.apiCall<Record<string, number>>(
        `projects/${projectPath}/languages`
      ).catch(() => ({}));
      const primaryLanguage = Object.entries(languages).sort((a, b) => b[1] - a[1])[0]?.[0];

      return {
        id: String(data.id),
        url: data.web_url,
        owner,
        name: data.name,
        fullName: data.path_with_namespace,
        description: data.description ?? "",
        language: primaryLanguage ?? null,
        stars: data.star_count,
        forks: data.forks_count,
        openIssues: data.open_issues_count,
        topics: data.topics ?? [],
        license: null, // Would need separate API call
        defaultBranch: data.default_branch,
        lastActivityAt: new Date(data.last_activity_at),
        hasContributingGuide: false,
        automatedTools: [],
      };
    } catch (error) {
      logger.debug(`Failed to get project info for ${owner}/${repo}: ${error}`);
      return null;
    }
  }

  // === Merge Request Operations ===

  async createPR(owner: string, repo: string, options: CreatePROptions): Promise<CreatePRResult> {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);

    interface MRCreateResponse {
      iid: number;
      web_url: string;
    }

    const body: Record<string, unknown> = {
      source_branch: options.head,
      target_branch: options.base,
      title: options.draft ? `Draft: ${options.title}` : options.title,
      description: options.body,
    };

    if (options.labels && options.labels.length > 0) {
      body["labels"] = options.labels.join(",");
    }

    if (options.reviewers && options.reviewers.length > 0) {
      // Need to convert usernames to user IDs - simplified for now
      // In production, would need to look up user IDs
      body["reviewer_ids"] = [];
    }

    const data = await this.apiCall<MRCreateResponse>(`projects/${projectPath}/merge_requests`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    return {
      url: data.web_url,
      number: data.iid,
      id: `${owner}/${repo}!${data.iid}`,
    };
  }

  async getPR(owner: string, repo: string, prNumber: number): Promise<PullRequest> {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const data = await this.apiCall<{
      iid: number;
      title: string;
      description: string | null;
      state: string;
      web_url: string;
      source_branch: string;
      target_branch: string;
      author: { username: string };
      draft: boolean;
      created_at: string;
      updated_at: string;
      sha: string;
      merge_status: string;
      user_notes_count: number;
    }>(`projects/${projectPath}/merge_requests/${prNumber}`);

    return {
      id: `${owner}/${repo}!${data.iid}`,
      url: data.web_url,
      number: data.iid,
      title: data.title,
      body: data.description ?? "",
      state: data.state === "merged" ? "merged" : data.state === "closed" ? "closed" : "open",
      isDraft: data.draft || data.title.startsWith("Draft:") || data.title.startsWith("WIP:"),
      mergeable:
        data.merge_status === "can_be_merged"
          ? true
          : data.merge_status === "cannot_be_merged"
            ? false
            : null,
      headBranch: data.source_branch,
      baseBranch: data.target_branch,
      headSha: data.sha,
      author: data.author.username,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at),
      linkedIssueUrl: null,
      commentCount: data.user_notes_count ?? 0,
      reviewCommentCount: 0,
      checksPass: null,
    };
  }

  async getReviews(owner: string, repo: string, prNumber: number): Promise<PRReview[]> {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const prId = `${owner}/${repo}!${prNumber}`;

    // Get MR to get the current SHA
    const mr = await this.apiCall<{ sha: string }>(
      `projects/${projectPath}/merge_requests/${prNumber}`
    );

    const data = await this.apiCall<{
      approved_by?: Array<{
        user: { id: number; username: string };
      }>;
    }>(`projects/${projectPath}/merge_requests/${prNumber}/approvals`).catch(() => ({
      approved_by: [],
    }));

    // GitLab approvals are different from GitHub reviews
    // Map them as best we can
    const approvals = data.approved_by ?? [];
    return approvals.map((approval) => ({
      id: String(approval.user.id),
      prId,
      state: "approved" as const,
      author: approval.user.username,
      body: null,
      submittedAt: new Date(),
      commitSha: mr.sha,
    }));
  }

  async getComments(owner: string, repo: string, prNumber: number): Promise<PRComment[]> {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const prId = `${owner}/${repo}!${prNumber}`;
    const data = await this.apiCall<
      Array<{
        id: number;
        author: { username: string };
        body: string;
        created_at: string;
        updated_at: string;
        position?: {
          new_path: string;
          new_line: number;
          old_line: number | null;
        };
      }>
    >(`projects/${projectPath}/merge_requests/${prNumber}/notes`);

    return data.map((note) => ({
      id: String(note.id),
      prId,
      author: note.author.username,
      body: note.body,
      createdAt: new Date(note.created_at),
      updatedAt: new Date(note.updated_at),
      isReviewComment: !!note.position,
      path: note.position?.new_path ?? null,
      line: note.position?.new_line ?? null,
      side: note.position ? ("RIGHT" as const) : null,
      originalLine: note.position?.old_line ?? null,
      inReplyToId: null,
    }));
  }

  async getChecks(owner: string, repo: string, prNumber: number): Promise<PRCheck[]> {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);

    // Get pipeline status for the MR
    const pipelines = await this.apiCall<
      Array<{
        id: number;
        status: string;
        web_url: string;
        created_at: string;
        finished_at: string | null;
      }>
    >(`projects/${projectPath}/merge_requests/${prNumber}/pipelines`).catch(() => []);

    return pipelines.map((pipeline) => ({
      id: String(pipeline.id),
      name: `Pipeline #${pipeline.id}`,
      status: this.mapPipelineStatus(pipeline.status),
      conclusion: this.mapPipelineConclusion(pipeline.status),
      detailsUrl: pipeline.web_url,
      startedAt: new Date(pipeline.created_at),
      completedAt: pipeline.finished_at ? new Date(pipeline.finished_at) : null,
      outputSummary: null,
      outputText: null,
    }));
  }

  async getPRFeedback(owner: string, repo: string, prNumber: number): Promise<PRFeedbackData> {
    const [pr, reviews, comments, checks] = await Promise.all([
      this.getPR(owner, repo, prNumber),
      this.getReviews(owner, repo, prNumber),
      this.getComments(owner, repo, prNumber),
      this.getChecks(owner, repo, prNumber),
    ]);

    return { pr, reviews, comments, checks };
  }

  async updatePR(
    owner: string,
    repo: string,
    prNumber: number,
    updates: UpdatePROptions
  ): Promise<void> {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const body: Record<string, unknown> = {};

    if (updates.title !== undefined) {
      body["title"] = updates.title;
    }

    if (updates.body !== undefined) {
      body["description"] = updates.body;
    }

    if (updates.state === "closed") {
      body["state_event"] = "close";
    } else if (updates.state === "open") {
      body["state_event"] = "reopen";
    }

    if (Object.keys(body).length > 0) {
      await this.apiCall(`projects/${projectPath}/merge_requests/${prNumber}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    }
  }

  async addComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    await this.apiCall(`projects/${projectPath}/merge_requests/${prNumber}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  // === Private Helpers ===

  private mapPipelineStatus(
    status: string
  ): "pending" | "success" | "failure" | "cancelled" | "skipped" {
    switch (status) {
      case "pending":
      case "created":
      case "running":
        return "pending";
      case "success":
        return "success";
      case "failed":
        return "failure";
      case "canceled":
        return "cancelled";
      case "skipped":
        return "skipped";
      default:
        return "pending";
    }
  }

  private mapPipelineConclusion(status: string): string | null {
    switch (status) {
      case "success":
        return "success";
      case "failed":
        return "failure";
      case "canceled":
        return "cancelled";
      case "skipped":
        return "skipped";
      case "pending":
      case "running":
      case "created":
        return null;
      default:
        return null;
    }
  }

  private async apiCall<T>(endpoint: string, options: globalThis.RequestInit = {}): Promise<T> {
    const url = `${this.gitlabBaseUrl}/api/v4/${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

    if (this.token) {
      headers["PRIVATE-TOKEN"] = this.token;
    }

    const response = await globalThis.fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitLab API error: ${response.status} ${response.statusText} - ${text}`);
    }

    return response.json() as Promise<T>;
  }

  private runGlab(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      if (this.token) {
        env["GITLAB_TOKEN"] = this.token;
      }

      const proc = spawn(this.glabPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
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
          reject(new Error(`glab ${args.join(" ")} failed: ${stderr || stdout}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn glab: ${err.message}`));
      });
    });
  }
}
