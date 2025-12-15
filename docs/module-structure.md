# Module Structure

This document defines the modular architecture of the OSS Contribution Agent. The system is designed to support two deployment modes (OSS and B2B) with maximum code reuse through a shared core.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLI Layer                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Common    │  │  OSS Mode   │  │  B2B Mode   │  │   Shared    │        │
│  │  Commands   │  │  Commands   │  │  Commands   │  │   Config    │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
├─────────────────────────────────────────────────────────────────────────────┤
│                           Mode-Specific Modules                              │
│  ┌────────────────────────────┐    ┌────────────────────────────┐          │
│  │         OSS Module         │    │         B2B Module         │          │
│  │  • Project Discovery       │    │  • Campaign Management     │          │
│  │  • Issue Selection/Scoring │    │  • Jira/Linear Integration │          │
│  │  • OSS Quality Gates       │    │  • Sentry Integration      │          │
│  │  • Automated Tool Detection│    │  • Reporting Engine        │          │
│  └────────────────────────────┘    └────────────────────────────┘          │
├─────────────────────────────────────────────────────────────────────────────┤
│                              Core Modules                                    │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │
│  │ Contribution │ │   Feedback   │ │    State     │ │    Budget    │       │
│  │    Engine    │ │     Loop     │ │   Manager    │ │   Manager    │       │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘       │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │
│  │     Git      │ │   Worktree   │ │  AI Provider │ │    Queue     │       │
│  │   Manager    │ │   Manager    │ │  Abstraction │ │   Manager    │       │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘       │
├─────────────────────────────────────────────────────────────────────────────┤
│                           Infrastructure Layer                               │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │
│  │    Logger    │ │    Config    │ │   Database   │ │     MCP      │       │
│  │              │ │    Loader    │ │   (SQLite)   │ │   Clients    │       │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Directory Structure

### Current Implementation (as of Phase 6)

```
src/
├── cli/                        # CLI commands and configuration
│   ├── index.ts               # CLI setup (Commander.js)
│   ├── config/
│   │   ├── index.ts           # Config exports
│   │   └── loader.ts          # Config loading and validation
│   └── commands/
│       ├── index.ts           # Command exports
│       ├── work.ts            # oss-agent work <issue-url>
│       ├── iterate.ts         # oss-agent iterate <pr-url>
│       ├── watch.ts           # oss-agent watch (placeholder)
│       ├── status.ts          # oss-agent status
│       ├── config.ts          # oss-agent config
│       ├── history.ts         # oss-agent history
│       ├── resume.ts          # oss-agent resume <session>
│       ├── cleanup.ts         # oss-agent cleanup
│       ├── discover.ts        # oss-agent discover
│       ├── suggest.ts         # oss-agent suggest
│       ├── queue.ts           # oss-agent queue
│       ├── run.ts             # oss-agent run (autonomous)
│       ├── work-parallel.ts   # oss-agent work-parallel
│       ├── parallel-status.ts # oss-agent parallel-status
│       ├── cancel.ts          # oss-agent cancel
│       └── campaign.ts        # oss-agent campaign (Phase 6)
│
├── core/                       # Shared core modules
│   ├── ai/                    # AI Provider abstraction
│   │   ├── types.ts           # AIProvider interface, QueryOptions, etc.
│   │   ├── claude-cli-provider.ts  # Claude CLI implementation
│   │   └── provider-factory.ts     # Provider factory
│   │
│   ├── engine/                # Issue Processing Engine
│   │   └── issue-processor.ts # Main orchestration (clone→AI→commit→PR)
│   │
│   ├── feedback/              # PR Feedback handling
│   │   └── feedback-parser.ts # Parse and classify PR comments
│   │
│   ├── git/                   # Git operations
│   │   └── git-operations.ts  # Clone, branch, commit, push, worktree
│   │
│   ├── github/                # GitHub API operations
│   │   └── repo-service.ts    # Fork management, permissions
│   │
│   ├── providers/             # Provider abstraction layer (Phase 6)
│   │   ├── index.ts           # Module exports
│   │   ├── factory.ts         # Provider factory with auto-detection
│   │   ├── url-parser.ts      # Multi-platform URL parsing
│   │   ├── repository/        # Repository providers
│   │   │   ├── index.ts       # Repository provider exports
│   │   │   ├── types.ts       # RepositoryProvider interface
│   │   │   ├── github.ts      # GitHub provider (gh CLI)
│   │   │   ├── github-enterprise.ts # GitHub Enterprise provider
│   │   │   └── gitlab.ts      # GitLab provider (glab CLI + REST)
│   │   └── issue-source/      # Issue source providers
│   │       ├── index.ts       # Issue source exports
│   │       ├── types.ts       # IssueSourceProvider interface
│   │       ├── github.ts      # GitHub Issues provider
│   │       ├── jira.ts        # Jira provider (REST API)
│   │       └── linear.ts      # Linear provider (GraphQL API)
│   │
│   └── state/                 # State persistence
│       └── state-manager.ts   # SQLite-based state (issues, sessions, campaigns)
│
├── oss/                        # OSS-specific modules
│   ├── discovery/             # Project discovery
│   │   ├── index.ts           # Module exports
│   │   └── discovery-service.ts # Find and score projects
│   │
│   └── selection/             # Issue selection
│       ├── index.ts           # Module exports
│       └── selection-service.ts # Find, filter, and score issues
│
├── b2b/                        # B2B-specific modules (Phase 6)
│   ├── index.ts               # Module exports
│   └── campaigns/             # Campaign management
│       ├── index.ts           # Campaign exports
│       ├── campaign-service.ts # Campaign CRUD, issue management
│       └── campaign-runner.ts # Campaign execution orchestration
│
├── infra/                      # Infrastructure utilities
│   ├── logger.ts              # Structured logging with colors
│   └── errors.ts              # Custom error types
│
└── types/                      # Shared type definitions
    ├── index.ts               # Re-exports
    ├── issue.ts               # Issue, IssueState, GitHubIssueInfo
    ├── project.ts             # Project, ProjectScore types
    ├── session.ts             # Session types
    ├── config.ts              # Config types with zod schemas
    ├── campaign.ts            # Campaign types and state machine (Phase 6)
    └── providers.ts           # Provider types (Phase 6)

tests/                          # Test files
├── core/
│   ├── ai-provider.test.ts    # AI provider tests
│   ├── feedback-parser.test.ts # Feedback parsing tests
│   ├── git-operations.test.ts # Git operations tests
│   ├── state-manager.test.ts  # State manager tests
│   └── providers.test.ts      # Provider URL parsing tests (Phase 6)
├── b2b/
│   └── campaign-service.test.ts # Campaign service tests (Phase 6)
├── infra/
│   └── logger.test.ts         # Logger tests
└── types/
    └── config.test.ts         # Config validation tests
```

### Planned Structure (Phase 7 - Future)

```
src/
├── cli/commands/
│   └── report.ts              # oss-agent report (analytics)
│
├── oss/
│   └── quality/               # OSS quality gates (enhanced)
│
├── b2b/
│   └── reporting/             # Reports and analytics engine
│
└── api/                        # MCP Server Mode (optional)
    └── mcp-server.ts          # Expose agent capabilities as MCP tools
```

---

## Core Modules Detail

### 1. Contribution Engine (`core/engine/`)

The heart of the system. Takes an issue and produces code changes.

```typescript
// contribution-engine.ts
export interface ContributionEngine {
  // Main entry point
  workOnIssue(issue: Issue, options: WorkOptions): Promise<WorkResult>;

  // Sub-steps (can be called individually)
  parseIssue(url: string): Promise<Issue>;
  gatherContext(issue: Issue, repo: Repository): Promise<Context>;
  generatePlan(issue: Issue, context: Context): Promise<Plan>;
  implement(plan: Plan): Promise<Implementation>;
  validate(implementation: Implementation): Promise<ValidationResult>;
  createPR(implementation: Implementation): Promise<PullRequest>;
}

export interface WorkOptions {
  maxBudget: number;
  maxTurns: number;
  dryRun: boolean;
  allowedPaths?: string[];
  disallowedPaths?: string[];
}

export interface WorkResult {
  success: boolean;
  pr?: PullRequest;
  cost: number;
  turns: number;
  error?: Error;
}
```

### 2. Git Manager (`core/git/`)

All git operations, including worktrees for parallel work.

```typescript
// git-manager.ts
export interface GitManager {
  clone(url: string, path: string): Promise<void>;
  fetch(path: string): Promise<void>;
  createBranch(path: string, name: string, base?: string): Promise<void>;
  commit(path: string, message: string): Promise<string>;
  push(path: string, branch: string): Promise<void>;
  getCurrentBranch(path: string): Promise<string>;
  hasUncommittedChanges(path: string): Promise<boolean>;
}

// worktree-manager.ts
export interface WorktreeManager {
  create(issue: Issue): Promise<Worktree>;
  remove(worktreeId: string): Promise<void>;
  list(): Promise<Worktree[]>;
  getActive(): Promise<Worktree[]>;
}
```

### 3. AI Provider (`core/ai/`)

Abstraction over AI providers, primarily Claude.

```typescript
// provider.ts
export interface AIProvider {
  name: string;

  query(prompt: string, options: QueryOptions): Promise<QueryResult>;
  estimateCost(prompt: string): number;
  getUsage(): UsageStats;
}

// claude-provider.ts
export class ClaudeProvider implements AIProvider {
  async query(prompt: string, options: QueryOptions): Promise<QueryResult> {
    const result = await sdkQuery({
      prompt,
      options: {
        model: options.model || "claude-sonnet-4-20250514",
        allowedTools: options.tools,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudget,
        permissionMode: "acceptEdits",
        cwd: options.workingDirectory
      }
    });

    return this.normalizeResult(result);
  }
}
```

### 4. Feedback Loop (`core/feedback/`)

Monitor PRs and respond to feedback.

```typescript
// monitor.ts
export interface FeedbackMonitor {
  watchPR(pr: PullRequest, sessionId: string): Promise<void>;
  checkForFeedback(pr: PullRequest): Promise<Feedback[]>;
  stopWatching(prUrl: string): Promise<void>;
}

// classifier.ts
export interface FeedbackClassifier {
  classify(feedback: RawFeedback): ClassifiedFeedback;
  isActionable(feedback: ClassifiedFeedback): boolean;
  requiresHuman(feedback: ClassifiedFeedback): boolean;
}

export type FeedbackType =
  | "approval"
  | "changes_requested"
  | "comment"
  | "automated_lint"
  | "automated_test"
  | "automated_security";
```

### 5. State Manager (`core/state/`)

Persistent storage for all operations.

```typescript
// state-manager.ts
export interface StateManager {
  // Issues
  saveIssue(issue: Issue): Promise<void>;
  getIssue(id: string): Promise<Issue | null>;
  updateIssueState(id: string, state: IssueState): Promise<void>;
  getIssuesByState(state: IssueState): Promise<Issue[]>;

  // Sessions
  saveSession(session: Session): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  getResumableSessions(): Promise<Session[]>;

  // Audit
  logAction(action: AuditAction): Promise<void>;
  getAuditLog(filters?: AuditFilters): Promise<AuditEntry[]>;
}

export type IssueState =
  | "discovered"
  | "queued"
  | "in_progress"
  | "pr_created"
  | "awaiting_feedback"
  | "iterating"
  | "merged"
  | "closed"
  | "abandoned";
```

### 6. Budget Manager (`core/budget/`)

Track and enforce spending limits.

```typescript
// budget-manager.ts
export interface BudgetManager {
  canSpend(amount: number): boolean;
  recordSpend(amount: number, operation: string): Promise<void>;
  getDailySpend(): Promise<number>;
  getMonthlySpend(): Promise<number>;
  getStatus(): Promise<BudgetStatus>;
  getRemainingBudget(): number;
}

export interface BudgetStatus {
  dailySpent: number;
  dailyLimit: number;
  monthlySpent: number;
  monthlyLimit: number;
  canContinue: boolean;
}
```

---

## OSS Modules Detail

### 1. Discovery Service (`oss/discovery/`)

Find projects to contribute to.

```typescript
// discovery-service.ts
export interface DiscoveryService {
  discover(config: DiscoveryConfig): Promise<Project[]>;
  scoreProject(project: Project): Promise<number>;
  detectAutomatedTools(project: Project): Promise<AutomatedTool[]>;
}

export interface DiscoveryConfig {
  mode: "direct" | "search" | "intelligent";

  // Direct mode
  directRepos?: string[];

  // Search mode
  searchCriteria?: SearchCriteria;

  // Intelligent mode
  query?: string;

  // Filters (all modes)
  filters: DiscoveryFilters;
}
```

### 2. Selection Service (`oss/selection/`)

Choose and prioritize issues.

```typescript
// selection-service.ts
export interface SelectionService {
  selectIssues(project: Project, config: SelectionConfig): Promise<Issue[]>;
  scoreIssue(issue: Issue, project: Project): number;
  detectConflicts(issues: Issue[]): Promise<ConflictMap>;
}

export interface SelectionConfig {
  filterMode: "unassigned_no_pr" | "all_open" | "custom";
  customFilters?: CustomFilters;
  maxIssues: number;
  labels: string[];
  excludeLabels: string[];
}
```

---

## B2B Modules Detail

### 1. Provider Abstraction (`core/providers/`)

Multi-platform support through provider interfaces.

```typescript
// repository/types.ts - Repository provider interface
export interface RepositoryProvider {
  info: ProviderInfo;
  capabilities: RepositoryCapabilities;

  // Availability
  isAvailable(): Promise<boolean>;
  testConnection(): Promise<ConnectionTestResult>;

  // URL handling
  canHandleUrl(url: string): boolean;
  parseUrl(url: string): ParsedUrl | null;

  // Repository operations
  cloneRepository(url: string, targetDir: string): Promise<void>;
  createBranch(repoPath: string, branchName: string): Promise<void>;
  createPR(options: CreatePROptions): Promise<PRResult>;
  getPR(prUrl: string): Promise<PRInfo | null>;
}

// issue-source/types.ts - Issue source provider interface
export interface IssueSourceProvider {
  info: ProviderInfo;
  capabilities: IssueSourceCapabilities;

  // Issue operations
  getIssue(issueRef: string): Promise<ProviderIssue | null>;
  queryIssues(projectKey: string, options?: IssueQueryOptions): Promise<IssueQueryResult>;
  addComment(issueRef: string, body: string): Promise<void>;
  transitionIssue(issueRef: string, transitionId: string): Promise<boolean>;
  linkToPR(issueRef: string, prUrl: string): Promise<void>;
}
```

**Implemented Providers:**
- **Repository**: GitHub, GitHub Enterprise, GitLab
- **Issue Source**: GitHub Issues, Jira (REST API), Linear (GraphQL)

### 2. Campaign Service (`b2b/campaigns/`)

Campaign lifecycle management and issue processing.

```typescript
// campaign-service.ts
export class CampaignService {
  // CRUD operations
  createCampaign(options: CreateCampaignOptions): Campaign;
  getCampaign(id: string): Campaign | null;
  listCampaigns(filters?: CampaignFilters): Campaign[];
  deleteCampaign(id: string): void;

  // Status transitions (with state machine validation)
  startCampaign(id: string, triggeredBy?: string): void;
  pauseCampaign(id: string, triggeredBy?: string, reason?: string): void;
  resumeCampaign(id: string, triggeredBy?: string): void;
  completeCampaign(id: string, triggeredBy?: string): void;
  cancelCampaign(id: string, triggeredBy?: string, reason?: string): void;

  // Issue management
  addIssues(campaignId: string, issues: CampaignIssueInput[]): number;
  removeIssues(campaignId: string, issueUrls: string[]): number;
  updateIssueStatus(campaignId: string, issueUrl: string, status: CampaignIssueStatus, updates?: IssueStatusUpdates): void;
  getNextIssue(campaignId: string): CampaignIssue | null;

  // Progress & budget
  getProgress(campaignId: string): CampaignProgress | null;
  isOverBudget(campaignId: string): boolean;
}

// campaign-runner.ts
export class CampaignRunner {
  run(campaignId: string, options?: RunOptions): Promise<RunResult>;
  // Processes issues, tracks progress, respects budget limits
}
```

**Campaign Status Lifecycle:**
```
draft → active → paused → active → completed
  ↓       ↓        ↓
cancelled  cancelled  cancelled
```

---

## Module Dependencies

```
                    CLI
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
       OSS         Core          B2B
        │            │            │
        │     ┌──────┴──────┐     │
        │     ▼             ▼     │
        └───►Engine◄───────────────┘
              │
        ┌─────┼─────┬─────┬─────┐
        ▼     ▼     ▼     ▼     ▼
       Git   AI   State Budget Queue
        │     │     │     │     │
        └─────┴─────┴─────┴─────┘
                    │
                    ▼
                  Infra
```

**Dependency Rules:**

1. `cli/` can import from `core/`, `oss/`, `b2b/`, `infra/`
2. `oss/` can import from `core/`, `infra/`
3. `b2b/` can import from `core/`, `infra/`
4. `core/` can only import from `infra/` and `types/`
5. `infra/` has no internal dependencies
6. No circular dependencies allowed

---

## Configuration

Configuration supports both modes with shared base:

```typescript
// types/config.ts
export interface Config {
  // Shared settings
  ai: {
    provider: "claude";
    model: string;
    apiKey?: string;  // Falls back to env
  };

  budget: {
    dailyLimit: number;
    monthlyLimit: number;
    perIssueLimit: number;
  };

  git: {
    defaultBranch: string;
    commitSignoff: boolean;
  };

  // Mode selection
  mode: "oss" | "b2b";

  // Mode-specific (only one active)
  oss?: OSSConfig;
  b2b?: B2BConfig;
}

export interface OSSConfig {
  discovery: DiscoveryConfig;
  selection: SelectionConfig;
  qualityGates: QualityGateConfig;
}

export interface B2BConfig {
  issueSource: "jira" | "linear" | "sentry";
  jira?: JiraConfig;
  linear?: LinearConfig;
  sentry?: SentryConfig;
  campaigns: CampaignDefaults;
}
```

---

## Plugin Architecture (Future)

The modular structure allows for future plugin support:

```typescript
// Future: plugins/interface.ts
export interface Plugin {
  name: string;
  version: string;

  // Lifecycle hooks
  onInit?(agent: Agent): Promise<void>;
  onIssueSelected?(issue: Issue): Promise<Issue>;
  onPRCreated?(pr: PullRequest): Promise<void>;
  onFeedbackReceived?(feedback: Feedback): Promise<void>;

  // Custom commands
  commands?: Command[];

  // Custom issue sources
  issueSource?: IssueSource;
}
```

This would allow third-party integrations without modifying core code.
