/**
 * Jira Issue Source Provider
 *
 * Implements IssueSourceProvider interface for Jira Cloud and Server.
 * Uses the Jira REST API with Basic Auth (email + API token).
 */

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
} from "../../../types/providers.js";
import type { Issue, IssueState, IssueComment } from "../../../types/issue.js";
import type { JiraConfig } from "../../../types/config.js";
import { logger } from "../../../infra/logger.js";

/**
 * Default status mappings from Jira statuses to internal states
 * Note: Internal IssueState uses workflow states, not simple status
 */
const DEFAULT_STATUS_MAPPING: Record<string, IssueState> = {
  open: "discovered",
  "to do": "queued",
  backlog: "discovered",
  "selected for development": "queued",
  "in progress": "in_progress",
  "in review": "in_progress",
  review: "in_progress",
  done: "merged",
  closed: "closed",
  resolved: "merged",
  "won't do": "abandoned",
  "won't fix": "abandoned",
  duplicate: "abandoned",
  invalid: "abandoned",
};

export class JiraIssueSourceProvider implements IssueSourceProvider {
  readonly info: ProviderInfo & { type: "jira" };

  readonly capabilities: IssueSourceCapabilities = {
    labels: true,
    assignment: true,
    priority: true,
    estimation: true,
    sprints: true,
    customFields: true,
    linking: true,
    workflows: true,
    externalPRLinking: true,
    webhooks: true,
  };

  private baseUrl: string = "";
  private email: string = "";
  private apiToken: string = "";
  private isServer: boolean = false;
  private jqlFilter: string = "";
  private statusMapping: Record<string, IssueState> = DEFAULT_STATUS_MAPPING;

  constructor() {
    this.info = {
      name: "Jira",
      type: "jira",
      version: "1.0.0",
      baseUrl: "",
    };
  }

  // === Lifecycle ===

  async initialize(config: ProviderConfig): Promise<void> {
    const jiraConfig = config.settings as JiraConfig;

    if (!jiraConfig.baseUrl) {
      throw new Error("Jira baseUrl is required");
    }
    if (!jiraConfig.email) {
      throw new Error("Jira email is required");
    }
    if (!jiraConfig.apiToken) {
      throw new Error("Jira apiToken is required");
    }
    if (!jiraConfig.projectKey) {
      throw new Error("Jira projectKey is required");
    }

    this.baseUrl = jiraConfig.baseUrl.replace(/\/$/, "");
    this.email = jiraConfig.email;
    this.apiToken = jiraConfig.apiToken;
    this.isServer = jiraConfig.isServer ?? false;
    this.jqlFilter = jiraConfig.jqlFilter ?? "";

    if (jiraConfig.statusMapping) {
      this.statusMapping = {
        ...DEFAULT_STATUS_MAPPING,
        ...Object.fromEntries(
          Object.entries(jiraConfig.statusMapping).map(([k, v]) => [
            k.toLowerCase(),
            v as IssueState,
          ])
        ),
      };
    }

    // Update info with actual base URL
    (this.info as { baseUrl: string }).baseUrl = this.baseUrl;
  }

  async isAvailable(): Promise<boolean> {
    return !!(this.baseUrl && this.email && this.apiToken);
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const user = await this.apiCall<{ displayName: string; emailAddress: string }>("myself");
      return {
        success: true,
        info: {
          user: user.displayName,
          email: user.emailAddress,
        },
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
    try {
      const parsed = new globalThis.URL(url);
      const jiraUrl = new globalThis.URL(this.baseUrl);
      return parsed.host === jiraUrl.host;
    } catch {
      // Check if it's a Jira key format (PROJ-123)
      return /^[A-Z][A-Z0-9]*-\d+$/.test(url);
    }
  }

  parseIssueRef(ref: string): ParsedIssueRef | null {
    // Try URL first
    try {
      const url = new globalThis.URL(ref);
      // Match /browse/PROJ-123 or /jira/browse/PROJ-123
      const match = url.pathname.match(/\/(?:jira\/)?browse\/([A-Z][A-Z0-9]*-\d+)/);
      if (match?.[1]) {
        const parts = match[1].split("-");
        return {
          projectKey: parts[0]!,
          issueNumber: parseInt(parts[1]!, 10),
          issueKey: match[1],
          url: ref,
        };
      }
    } catch {
      // Not a URL, try as issue key
    }

    // Try as issue key (PROJ-123)
    const keyMatch = ref.match(/^([A-Z][A-Z0-9]*)-(\d+)$/);
    if (keyMatch?.[1] && keyMatch[2]) {
      return {
        projectKey: keyMatch[1],
        issueNumber: parseInt(keyMatch[2], 10),
        issueKey: ref,
        url: this.buildIssueUrl(keyMatch[1], ref),
      };
    }

    return null;
  }

  buildIssueUrl(projectKey: string, issueKey: string | number): string {
    const key = typeof issueKey === "number" ? `${projectKey}-${issueKey}` : issueKey;
    return `${this.baseUrl}/browse/${key}`;
  }

  // === Issue Operations ===

  async getIssue(issueRef: string): Promise<ProviderIssue | null> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed) {
      return null;
    }

    try {
      const issue = await this.apiCall<JiraIssue>(`issue/${parsed.issueKey}`, {
        params: {
          expand: "renderedFields,names,changelog",
        },
      });

      return this.mapJiraIssue(issue);
    } catch (error) {
      logger.debug(`Failed to fetch Jira issue ${issueRef}: ${error}`);
      return null;
    }
  }

  async queryIssues(projectKey: string, options?: IssueQueryOptions): Promise<IssueQueryResult> {
    const jql = this.buildJQL(projectKey, options);
    const startAt = options?.offset ?? 0;
    const maxResults = options?.limit ?? 50;

    const result = await this.apiCall<{
      issues: JiraIssue[];
      total: number;
      startAt: number;
      maxResults: number;
    }>("search", {
      method: "POST",
      body: JSON.stringify({
        jql,
        startAt,
        maxResults,
        expand: ["renderedFields"],
      }),
    });

    const issues = result.issues.map((issue) => this.mapJiraIssue(issue));

    return {
      issues,
      totalCount: result.total,
      hasMore: startAt + result.issues.length < result.total,
      nextCursor: String(startAt + result.issues.length),
    };
  }

  async getLabels(projectKey: string): Promise<string[]> {
    const result = await this.apiCall<{ values: Array<{ name: string }> }>(
      `project/${projectKey}/components`
    ).catch(() => ({ values: [] }));

    // Also get labels
    const labels = await this.apiCall<{ values: string[] }>("label").catch(() => ({ values: [] }));

    const components = result.values.map((c) => c.name);
    return [...new Set([...components, ...labels.values])];
  }

  async getComments(issueRef: string): Promise<IssueComment[]> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed) {
      return [];
    }

    const result = await this.apiCall<{
      comments: Array<{
        id: string;
        body: string;
        author: { displayName: string; emailAddress: string };
        created: string;
        updated: string;
      }>;
    }>(`issue/${parsed.issueKey}/comment`);

    return result.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      author: comment.author.displayName,
      createdAt: new Date(comment.created),
    }));
  }

  // === Issue Updates ===

  async addComment(issueRef: string, body: string): Promise<void> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed) {
      throw new Error(`Invalid issue reference: ${issueRef}`);
    }

    await this.apiCall(`issue/${parsed.issueKey}/comment`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async transitionIssue(issueRef: string, transitionId: string): Promise<boolean> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed) {
      return false;
    }

    try {
      await this.apiCall(`issue/${parsed.issueKey}/transitions`, {
        method: "POST",
        body: JSON.stringify({
          transition: { id: transitionId },
        }),
      });
      return true;
    } catch (error) {
      logger.error(`Failed to transition issue ${issueRef}: ${error}`);
      return false;
    }
  }

  async getTransitions(issueRef: string): Promise<IssueTransitionOption[]> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed) {
      return [];
    }

    const result = await this.apiCall<{
      transitions: Array<{
        id: string;
        name: string;
        to: { name: string };
      }>;
    }>(`issue/${parsed.issueKey}/transitions`);

    return result.transitions.map((t) => ({
      id: t.id,
      name: t.name,
      toStatus: t.to.name,
    }));
  }

  async assignIssue(issueRef: string, assignee: string | null): Promise<void> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed) {
      throw new Error(`Invalid issue reference: ${issueRef}`);
    }

    // For Jira Cloud, we need the account ID
    // For simplicity, assume assignee is already the account ID or -1 for unassigned
    await this.apiCall(`issue/${parsed.issueKey}/assignee`, {
      method: "PUT",
      body: JSON.stringify({
        accountId: assignee,
      }),
    });
  }

  async addLabels(issueRef: string, labels: string[]): Promise<void> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed) {
      throw new Error(`Invalid issue reference: ${issueRef}`);
    }

    await this.apiCall(`issue/${parsed.issueKey}`, {
      method: "PUT",
      body: JSON.stringify({
        update: {
          labels: labels.map((label) => ({ add: label })),
        },
      }),
    });
  }

  async removeLabels(issueRef: string, labels: string[]): Promise<void> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed) {
      throw new Error(`Invalid issue reference: ${issueRef}`);
    }

    await this.apiCall(`issue/${parsed.issueKey}`, {
      method: "PUT",
      body: JSON.stringify({
        update: {
          labels: labels.map((label) => ({ remove: label })),
        },
      }),
    });
  }

  async linkToPR(issueRef: string, prUrl: string): Promise<void> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed) {
      throw new Error(`Invalid issue reference: ${issueRef}`);
    }

    // Create a remote link to the PR
    await this.apiCall(`issue/${parsed.issueKey}/remotelink`, {
      method: "POST",
      body: JSON.stringify({
        object: {
          url: prUrl,
          title: `Pull Request: ${prUrl.split("/").pop()}`,
          icon: {
            url16x16: "https://github.githubassets.com/favicons/favicon.svg",
            title: "Pull Request",
          },
        },
      }),
    });
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
      case "discovered":
        return "Open";
      case "queued":
        return "To Do";
      case "in_progress":
      case "iterating":
        return "In Progress";
      case "pr_created":
      case "awaiting_feedback":
        return "In Review";
      case "merged":
        return "Done";
      case "closed":
        return "Closed";
      case "abandoned":
        return "Won't Do";
      default:
        return "To Do";
    }
  }

  mapExternalStatusToState(status: string): IssueState {
    const normalized = status.toLowerCase();
    return this.statusMapping[normalized] ?? "discovered";
  }

  // === Private Helpers ===

  private buildJQL(projectKey: string, options?: IssueQueryOptions): string {
    const conditions: string[] = [`project = "${projectKey}"`];

    // Add base filter if configured
    if (this.jqlFilter) {
      conditions.push(`(${this.jqlFilter})`);
    }

    if (options?.state === "open") {
      conditions.push('statusCategory != "Done"');
    } else if (options?.state === "closed") {
      conditions.push('statusCategory = "Done"');
    }

    if (options?.labels && options.labels.length > 0) {
      const labelConditions = options.labels.map((l) => `labels = "${l}"`);
      conditions.push(`(${labelConditions.join(" AND ")})`);
    }

    if (options?.excludeLabels && options.excludeLabels.length > 0) {
      const excludeConditions = options.excludeLabels.map((l) => `labels != "${l}"`);
      conditions.push(excludeConditions.join(" AND "));
    }

    if (options?.assignee === null) {
      conditions.push("assignee IS EMPTY");
    } else if (options?.assignee) {
      conditions.push(`assignee = "${options.assignee}"`);
    }

    if (options?.author) {
      conditions.push(`reporter = "${options.author}"`);
    }

    if (options?.updatedAfter) {
      const dateStr = options.updatedAfter.toISOString().split("T")[0];
      conditions.push(`updated >= "${dateStr}"`);
    }

    if (options?.customQuery) {
      conditions.push(`(${options.customQuery})`);
    }

    let jql = conditions.join(" AND ");

    // Add ordering
    const sortField = options?.sortBy ?? "created";
    const sortDir = options?.sortDirection ?? "desc";
    const jqlSortField =
      sortField === "priority" ? "priority" : sortField === "updated" ? "updated" : "created";
    jql += ` ORDER BY ${jqlSortField} ${sortDir.toUpperCase()}`;

    return jql;
  }

  private mapJiraIssue(issue: JiraIssue): ProviderIssue {
    const fields = issue.fields;

    // Map priority
    let priority: ProviderIssue["priority"] = "medium";
    if (fields.priority) {
      const p = fields.priority.name.toLowerCase();
      if (p.includes("highest") || p.includes("blocker") || p.includes("critical")) {
        priority = "highest";
      } else if (p.includes("high") || p.includes("major")) {
        priority = "high";
      } else if (p.includes("low") || p.includes("minor")) {
        priority = "low";
      } else if (p.includes("lowest") || p.includes("trivial")) {
        priority = "lowest";
      }
    }

    return {
      externalId: issue.id,
      url: `${this.baseUrl}/browse/${issue.key}`,
      key: issue.key,
      number: parseInt(issue.key.split("-")[1]!, 10),
      title: fields.summary,
      body: fields.description ?? "",
      status: fields.status.name,
      priority,
      labels: fields.labels ?? [],
      createdAt: new Date(fields.created),
      updatedAt: new Date(fields.updated),
      author: fields.reporter?.displayName ?? "Unknown",
      assignees: fields.assignee ? [fields.assignee.displayName] : [],
      comments: [],
      source: "jira",
      metadata: {
        projectKey: issue.key.split("-")[0],
        issueType: fields.issuetype?.name,
        resolution: fields.resolution?.name,
        components: fields.components?.map((c) => c.name),
        fixVersions: fields.fixVersions?.map((v) => v.name),
      },
    };
  }

  private async apiCall<T>(
    endpoint: string,
    options: {
      method?: string;
      body?: string;
      params?: Record<string, string>;
    } = {}
  ): Promise<T> {
    const apiPath = this.isServer ? "/rest/api/2" : "/rest/api/3";
    let url = `${this.baseUrl}${apiPath}/${endpoint}`;

    if (options.params) {
      const params = new globalThis.URLSearchParams(options.params);
      url += `?${params.toString()}`;
    }

    const auth = Buffer.from(`${this.email}:${this.apiToken}`).toString("base64");

    const fetchOptions: globalThis.RequestInit = {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };

    if (options.body) {
      fetchOptions.body = options.body;
    }

    const response = await globalThis.fetch(url, fetchOptions);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jira API error: ${response.status} ${response.statusText} - ${text}`);
    }

    // Handle empty responses
    const text = await response.text();
    if (!text) {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }
}

// === Jira API Types ===

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: string | null;
    status: { name: string };
    priority?: { name: string };
    labels?: string[];
    created: string;
    updated: string;
    reporter?: { displayName: string; emailAddress: string };
    assignee?: { displayName: string; emailAddress: string };
    issuetype?: { name: string };
    resolution?: { name: string };
    components?: Array<{ name: string }>;
    fixVersions?: Array<{ name: string }>;
  };
}
