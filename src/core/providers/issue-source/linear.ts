/**
 * Linear Issue Source Provider
 *
 * Implements IssueSourceProvider interface for Linear.
 * Uses the Linear GraphQL API with API key authentication.
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
import type { LinearConfig } from "../../../types/config.js";
import { logger } from "../../../infra/logger.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * Linear state name to internal state mapping
 * Note: Internal IssueState uses workflow states, not simple status
 */
const STATE_MAPPING: Record<string, IssueState> = {
  backlog: "discovered",
  unstarted: "queued",
  todo: "queued",
  started: "in_progress",
  "in progress": "in_progress",
  "in review": "awaiting_feedback",
  done: "merged",
  completed: "merged",
  canceled: "abandoned",
  cancelled: "abandoned",
  duplicate: "abandoned",
};

export class LinearIssueSourceProvider implements IssueSourceProvider {
  readonly info: ProviderInfo & { type: "linear" } = {
    name: "Linear",
    type: "linear",
    version: "1.0.0",
    baseUrl: "https://linear.app",
  };

  readonly capabilities: IssueSourceCapabilities = {
    labels: true,
    assignment: true,
    priority: true,
    estimation: true,
    sprints: true, // Cycles
    customFields: false, // Linear doesn't have custom fields in the same way
    linking: true,
    workflows: true,
    externalPRLinking: true,
    webhooks: true,
  };

  private apiKey: string = "";
  private teamId: string = "";
  private teamKey: string = ""; // e.g., "ENG" for team identifier in issue keys
  private projectId: string = "";
  private cycleId: string = "";
  private stateFilter: string[] = [];
  private priorityFilter: number[] = [];
  private labelFilter: string[] = [];

  // Cache for workflow states
  private workflowStates: Map<string, { id: string; name: string; type: string }> = new Map();

  // === Lifecycle ===

  async initialize(config: ProviderConfig): Promise<void> {
    const linearConfig = config.settings as LinearConfig;

    if (!linearConfig.apiKey) {
      throw new Error("Linear apiKey is required");
    }
    if (!linearConfig.teamId) {
      throw new Error("Linear teamId is required");
    }

    this.apiKey = linearConfig.apiKey;
    this.teamId = linearConfig.teamId;
    this.projectId = linearConfig.projectId ?? "";
    this.cycleId = linearConfig.cycleId ?? "";
    this.stateFilter = linearConfig.stateFilter ?? [];
    this.priorityFilter = linearConfig.priorityFilter ?? [];
    this.labelFilter = linearConfig.labelFilter ?? [];

    // Fetch team key
    await this.loadTeamInfo();
    await this.loadWorkflowStates();
  }

  async isAvailable(): Promise<boolean> {
    return !!(this.apiKey && this.teamId);
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const result = await this.graphql<{ viewer: { name: string; email: string } }>(`
        query {
          viewer {
            name
            email
          }
        }
      `);

      return {
        success: true,
        info: {
          user: result.viewer.name,
          email: result.viewer.email,
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
      return parsed.host === "linear.app";
    } catch {
      // Check if it's a Linear issue identifier (TEAM-123)
      return /^[A-Z]+-\d+$/.test(url);
    }
  }

  parseIssueRef(ref: string): ParsedIssueRef | null {
    // Try URL first
    // Linear URLs: https://linear.app/workspace/issue/TEAM-123/issue-title
    try {
      const url = new globalThis.URL(ref);
      if (url.host === "linear.app") {
        const match = url.pathname.match(/\/issue\/([A-Z]+-\d+)/);
        if (match?.[1]) {
          const parts = match[1].split("-");
          return {
            projectKey: parts[0]!,
            issueNumber: parseInt(parts[1]!, 10),
            issueKey: match[1],
            url: ref,
          };
        }
      }
    } catch {
      // Not a URL
    }

    // Try as issue identifier (TEAM-123)
    const keyMatch = ref.match(/^([A-Z]+)-(\d+)$/);
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

  buildIssueUrl(_projectKey: string, issueKey: string | number): string {
    // Linear URLs need the workspace slug, which we'd need to fetch
    // For now, use the identifier which redirects
    const key = typeof issueKey === "number" ? `${this.teamKey}-${issueKey}` : issueKey;
    return `https://linear.app/issue/${key}`;
  }

  // === Issue Operations ===

  async getIssue(issueRef: string): Promise<ProviderIssue | null> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed) {
      return null;
    }

    try {
      const result = await this.graphql<{ issue: LinearIssue | null }>(
        `
        query GetIssue($id: String!) {
          issue(id: $id) {
            ${ISSUE_FIELDS}
          }
        }
      `,
        { id: parsed.issueKey }
      );

      if (!result.issue) {
        // Try by identifier
        const searchResult = await this.graphql<{ issueSearch: { nodes: LinearIssue[] } }>(
          `
          query SearchIssue($query: String!) {
            issueSearch(query: $query, first: 1) {
              nodes {
                ${ISSUE_FIELDS}
              }
            }
          }
        `,
          { query: `identifier:${parsed.issueKey}` }
        );

        if (searchResult.issueSearch.nodes.length > 0) {
          return this.mapLinearIssue(searchResult.issueSearch.nodes[0]!);
        }
        return null;
      }

      return this.mapLinearIssue(result.issue);
    } catch (error) {
      logger.debug(`Failed to fetch Linear issue ${issueRef}: ${error}`);
      return null;
    }
  }

  async queryIssues(_projectKey: string, options?: IssueQueryOptions): Promise<IssueQueryResult> {
    const filters: string[] = [`team: { id: { eq: "${this.teamId}" } }`];

    if (this.projectId) {
      filters.push(`project: { id: { eq: "${this.projectId}" } }`);
    }

    if (this.cycleId) {
      filters.push(`cycle: { id: { eq: "${this.cycleId}" } }`);
    }

    // State filter
    if (options?.state === "open") {
      filters.push(`completedAt: { null: true }`);
      filters.push(`canceledAt: { null: true }`);
    } else if (options?.state === "closed") {
      filters.push(`or: [{ completedAt: { null: false } }, { canceledAt: { null: false } }]`);
    }

    // Label filter
    const labelFilters = [...(options?.labels ?? []), ...(this.labelFilter ?? [])];
    if (labelFilters.length > 0) {
      const labelConditions = labelFilters.map((l) => `{ name: { eq: "${l}" } }`);
      filters.push(`labels: { some: { or: [${labelConditions.join(", ")}] } }`);
    }

    // Exclude labels
    if (options?.excludeLabels && options.excludeLabels.length > 0) {
      const excludeConditions = options.excludeLabels.map((l) => `{ name: { eq: "${l}" } }`);
      filters.push(`labels: { every: { not: { or: [${excludeConditions.join(", ")}] } } }`);
    }

    // Assignee
    if (options?.assignee === null) {
      filters.push(`assignee: { null: true }`);
    } else if (options?.assignee) {
      filters.push(`assignee: { displayName: { eq: "${options.assignee}" } }`);
    }

    // Priority filter
    const priorities = options?.sortBy === "priority" ? this.priorityFilter : undefined;
    if (priorities && priorities.length > 0) {
      const priorityConditions = priorities.map((p) => `{ priority: { eq: ${p} } }`);
      filters.push(`or: [${priorityConditions.join(", ")}]`);
    }

    // State filter from config
    if (this.stateFilter && this.stateFilter.length > 0) {
      const stateConditions = this.stateFilter.map((s) => `{ name: { eq: "${s}" } }`);
      filters.push(`state: { or: [${stateConditions.join(", ")}] }`);
    }

    // Updated after
    if (options?.updatedAfter) {
      filters.push(`updatedAt: { gte: "${options.updatedAfter.toISOString()}" }`);
    }

    const filterStr = filters.length > 0 ? `filter: { ${filters.join(", ")} }` : "";
    const first = options?.limit ?? 50;
    const after = options?.cursor ? `, after: "${options.cursor}"` : "";

    // Sorting
    let orderBy = "createdAt";
    if (options?.sortBy === "updated") {
      orderBy = "updatedAt";
    } else if (options?.sortBy === "priority") {
      orderBy = "priority";
    }

    const result = await this.graphql<{
      issues: {
        nodes: LinearIssue[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(
      `
      query ListIssues($first: Int!) {
        issues(first: $first${after}, ${filterStr}, orderBy: ${orderBy}) {
          nodes {
            ${ISSUE_FIELDS}
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `,
      { first }
    );

    const issues = result.issues.nodes.map((issue) => this.mapLinearIssue(issue));

    const queryResult: IssueQueryResult = {
      issues,
      hasMore: result.issues.pageInfo.hasNextPage,
    };

    if (result.issues.pageInfo.endCursor) {
      queryResult.nextCursor = result.issues.pageInfo.endCursor;
    }

    return queryResult;
  }

  async getLabels(_projectKey: string): Promise<string[]> {
    const result = await this.graphql<{
      team: { labels: { nodes: Array<{ name: string }> } };
    }>(
      `
      query GetLabels($teamId: String!) {
        team(id: $teamId) {
          labels {
            nodes {
              name
            }
          }
        }
      }
    `,
      { teamId: this.teamId }
    );

    return result.team.labels.nodes.map((l) => l.name);
  }

  async getComments(issueRef: string): Promise<IssueComment[]> {
    const parsed = this.parseIssueRef(issueRef);
    if (!parsed) {
      return [];
    }

    // First get the issue ID
    const issue = await this.getIssue(issueRef);
    if (!issue) {
      return [];
    }

    const result = await this.graphql<{
      issue: {
        comments: {
          nodes: Array<{
            id: string;
            body: string;
            user: { name: string };
            createdAt: string;
            updatedAt: string;
          }>;
        };
      };
    }>(
      `
      query GetComments($id: String!) {
        issue(id: $id) {
          comments {
            nodes {
              id
              body
              user { name }
              createdAt
              updatedAt
            }
          }
        }
      }
    `,
      { id: issue.externalId }
    );

    return result.issue.comments.nodes.map((c) => ({
      id: c.id,
      body: c.body,
      author: c.user.name,
      createdAt: new Date(c.createdAt),
    }));
  }

  // === Issue Updates ===

  async addComment(issueRef: string, body: string): Promise<void> {
    const issue = await this.getIssue(issueRef);
    if (!issue) {
      throw new Error(`Issue not found: ${issueRef}`);
    }

    await this.graphql(
      `
      mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `,
      { issueId: issue.externalId, body }
    );
  }

  async transitionIssue(issueRef: string, transitionId: string): Promise<boolean> {
    const issue = await this.getIssue(issueRef);
    if (!issue) {
      return false;
    }

    try {
      await this.graphql(
        `
        mutation UpdateIssueState($issueId: String!, $stateId: String!) {
          issueUpdate(id: $issueId, input: { stateId: $stateId }) {
            success
          }
        }
      `,
        { issueId: issue.externalId, stateId: transitionId }
      );
      return true;
    } catch (error) {
      logger.error(`Failed to transition Linear issue ${issueRef}: ${error}`);
      return false;
    }
  }

  async getTransitions(_issueRef: string): Promise<IssueTransitionOption[]> {
    // Return all workflow states as possible transitions
    return Array.from(this.workflowStates.values()).map((state) => ({
      id: state.id,
      name: state.name,
      toStatus: state.name,
    }));
  }

  async assignIssue(issueRef: string, assignee: string | null): Promise<void> {
    const issue = await this.getIssue(issueRef);
    if (!issue) {
      throw new Error(`Issue not found: ${issueRef}`);
    }

    // Need to look up user ID by name/email
    let assigneeId: string | null = null;
    if (assignee) {
      const userResult = await this.graphql<{
        users: { nodes: Array<{ id: string }> };
      }>(
        `
        query FindUser($name: String!) {
          users(filter: { displayName: { eq: $name } }) {
            nodes { id }
          }
        }
      `,
        { name: assignee }
      );

      if (userResult.users.nodes.length > 0) {
        assigneeId = userResult.users.nodes[0]!.id;
      }
    }

    await this.graphql(
      `
      mutation AssignIssue($issueId: String!, $assigneeId: String) {
        issueUpdate(id: $issueId, input: { assigneeId: $assigneeId }) {
          success
        }
      }
    `,
      { issueId: issue.externalId, assigneeId }
    );
  }

  async addLabels(issueRef: string, labels: string[]): Promise<void> {
    const issue = await this.getIssue(issueRef);
    if (!issue) {
      throw new Error(`Issue not found: ${issueRef}`);
    }

    // Get label IDs
    const labelIds = await this.getLabelIds(labels);

    // Get current labels and add new ones
    const currentLabels = (issue.metadata["labelIds"] as string[]) ?? [];
    const newLabelIds = [...new Set([...currentLabels, ...labelIds])];

    await this.graphql(
      `
      mutation AddLabels($issueId: String!, $labelIds: [String!]!) {
        issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
          success
        }
      }
    `,
      { issueId: issue.externalId, labelIds: newLabelIds }
    );
  }

  async removeLabels(issueRef: string, labels: string[]): Promise<void> {
    const issue = await this.getIssue(issueRef);
    if (!issue) {
      throw new Error(`Issue not found: ${issueRef}`);
    }

    const labelIdsToRemove = new Set(await this.getLabelIds(labels));
    const currentLabels = (issue.metadata["labelIds"] as string[]) ?? [];
    const newLabelIds = currentLabels.filter((id) => !labelIdsToRemove.has(id));

    await this.graphql(
      `
      mutation RemoveLabels($issueId: String!, $labelIds: [String!]!) {
        issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
          success
        }
      }
    `,
      { issueId: issue.externalId, labelIds: newLabelIds }
    );
  }

  async linkToPR(issueRef: string, prUrl: string): Promise<void> {
    const issue = await this.getIssue(issueRef);
    if (!issue) {
      throw new Error(`Issue not found: ${issueRef}`);
    }

    // Linear has native GitHub integration, but we can create an attachment
    await this.graphql(
      `
      mutation LinkPR($issueId: String!, $url: String!, $title: String!) {
        attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) {
          success
        }
      }
    `,
      {
        issueId: issue.externalId,
        url: prUrl,
        title: `Pull Request: ${prUrl.split("/").pop()}`,
      }
    );
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
        return "Backlog";
      case "queued":
        return "Todo";
      case "in_progress":
      case "iterating":
        return "In Progress";
      case "pr_created":
      case "awaiting_feedback":
        return "In Review";
      case "merged":
        return "Done";
      case "closed":
        return "Done";
      case "abandoned":
        return "Canceled";
      default:
        return "Backlog";
    }
  }

  mapExternalStatusToState(status: string): IssueState {
    const normalized = status.toLowerCase();
    return STATE_MAPPING[normalized] ?? "discovered";
  }

  // === Private Helpers ===

  private async loadTeamInfo(): Promise<void> {
    const result = await this.graphql<{ team: { key: string } }>(
      `
      query GetTeam($teamId: String!) {
        team(id: $teamId) {
          key
        }
      }
    `,
      { teamId: this.teamId }
    );

    this.teamKey = result.team.key;
  }

  private async loadWorkflowStates(): Promise<void> {
    const result = await this.graphql<{
      workflowStates: { nodes: Array<{ id: string; name: string; type: string }> };
    }>(
      `
      query GetWorkflowStates($teamId: String!) {
        workflowStates(filter: { team: { id: { eq: $teamId } } }) {
          nodes {
            id
            name
            type
          }
        }
      }
    `,
      { teamId: this.teamId }
    );

    this.workflowStates.clear();
    for (const state of result.workflowStates.nodes) {
      this.workflowStates.set(state.name.toLowerCase(), state);
    }
  }

  private async getLabelIds(labelNames: string[]): Promise<string[]> {
    const result = await this.graphql<{
      team: { labels: { nodes: Array<{ id: string; name: string }> } };
    }>(
      `
      query GetLabelIds($teamId: String!) {
        team(id: $teamId) {
          labels {
            nodes {
              id
              name
            }
          }
        }
      }
    `,
      { teamId: this.teamId }
    );

    const labelMap = new Map(result.team.labels.nodes.map((l) => [l.name.toLowerCase(), l.id]));
    return labelNames
      .map((name) => labelMap.get(name.toLowerCase()))
      .filter((id): id is string => !!id);
  }

  private mapLinearIssue(issue: LinearIssue): ProviderIssue {
    // Map priority (Linear: 0=no priority, 1=urgent, 2=high, 3=medium, 4=low)
    let priority: ProviderIssue["priority"] = "none";
    switch (issue.priority) {
      case 1:
        priority = "highest";
        break;
      case 2:
        priority = "high";
        break;
      case 3:
        priority = "medium";
        break;
      case 4:
        priority = "low";
        break;
    }

    return {
      externalId: issue.id,
      url: issue.url,
      key: issue.identifier,
      number: issue.number,
      title: issue.title,
      body: issue.description ?? "",
      status: issue.state.name,
      priority,
      labels: issue.labels.nodes.map((l) => l.name),
      createdAt: new Date(issue.createdAt),
      updatedAt: new Date(issue.updatedAt),
      author: issue.creator?.name ?? "Unknown",
      assignees: issue.assignee ? [issue.assignee.name] : [],
      comments: [],
      source: "linear",
      metadata: {
        teamId: this.teamId,
        teamKey: this.teamKey,
        projectId: issue.project?.id,
        cycleId: issue.cycle?.id,
        estimate: issue.estimate,
        stateType: issue.state.type,
        labelIds: issue.labels.nodes.map((l) => l.id),
      },
    };
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await globalThis.fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        Authorization: this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Linear API error: ${response.status} ${response.statusText} - ${text}`);
    }

    const result = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

    if (result.errors && result.errors.length > 0) {
      throw new Error(`Linear GraphQL error: ${result.errors.map((e) => e.message).join(", ")}`);
    }

    if (!result.data) {
      throw new Error("Linear API returned no data");
    }

    return result.data;
  }
}

// === GraphQL Fragments ===

const ISSUE_FIELDS = `
  id
  identifier
  number
  title
  description
  url
  priority
  estimate
  createdAt
  updatedAt
  state {
    id
    name
    type
  }
  labels {
    nodes {
      id
      name
    }
  }
  assignee {
    id
    name
  }
  creator {
    name
  }
  project {
    id
    name
  }
  cycle {
    id
    name
  }
`;

// === Linear API Types ===

interface LinearIssue {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  estimate: number | null;
  createdAt: string;
  updatedAt: string;
  state: {
    id: string;
    name: string;
    type: string;
  };
  labels: {
    nodes: Array<{ id: string; name: string }>;
  };
  assignee: { id: string; name: string } | null;
  creator: { name: string } | null;
  project: { id: string; name: string } | null;
  cycle: { id: string; name: string } | null;
}
