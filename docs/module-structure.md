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

```
src/
├── index.ts                    # Main entry point
├── cli/                        # CLI commands and configuration
│   ├── index.ts               # CLI setup (Commander.js)
│   ├── commands/
│   │   ├── work.ts            # oss-agent work <issue-url>
│   │   ├── status.ts          # oss-agent status
│   │   ├── config.ts          # oss-agent config
│   │   ├── history.ts         # oss-agent history
│   │   ├── resume.ts          # oss-agent resume <session>
│   │   ├── oss/               # OSS-specific commands
│   │   │   ├── discover.ts    # oss-agent discover
│   │   │   ├── suggest.ts     # oss-agent suggest
│   │   │   ├── queue.ts       # oss-agent queue
│   │   │   └── run.ts         # oss-agent run (autonomous)
│   │   └── b2b/               # B2B-specific commands
│   │       ├── campaign.ts    # oss-agent campaign
│   │       └── report.ts      # oss-agent report
│   └── config/
│       ├── schema.ts          # Config schema (zod)
│       └── loader.ts          # Load from file/env
│
├── core/                       # Shared core modules
│   ├── index.ts               # Core exports
│   ├── engine/                # Contribution Engine
│   │   ├── index.ts
│   │   ├── contribution-engine.ts
│   │   ├── issue-parser.ts
│   │   ├── context-gatherer.ts
│   │   ├── prompt-builder.ts
│   │   └── types.ts
│   ├── git/                   # Git operations
│   │   ├── index.ts
│   │   ├── git-manager.ts
│   │   ├── worktree-manager.ts
│   │   ├── branch-naming.ts
│   │   └── types.ts
│   ├── ai/                    # AI Provider abstraction
│   │   ├── index.ts
│   │   ├── provider.ts        # AIProvider interface
│   │   ├── claude-provider.ts # Claude Agent SDK implementation
│   │   ├── cost-tracker.ts
│   │   └── types.ts
│   ├── feedback/              # Feedback loop
│   │   ├── index.ts
│   │   ├── monitor.ts         # PR monitoring
│   │   ├── classifier.ts      # Feedback classification
│   │   ├── responder.ts       # Generate responses
│   │   └── types.ts
│   ├── state/                 # State persistence
│   │   ├── index.ts
│   │   ├── state-manager.ts
│   │   ├── database.ts        # SQLite wrapper
│   │   ├── migrations/        # Schema migrations
│   │   └── types.ts
│   ├── budget/                # Budget management
│   │   ├── index.ts
│   │   ├── budget-manager.ts
│   │   └── types.ts
│   ├── queue/                 # Work queue
│   │   ├── index.ts
│   │   ├── queue-manager.ts
│   │   └── types.ts
│   └── hooks/                 # Claude Code hooks
│       ├── index.ts
│       ├── templates/         # Hook script templates
│       │   ├── on-session-stop.sh
│       │   ├── on-session-start.sh
│       │   └── on-pr-created.sh
│       └── installer.ts       # Install hooks to project
│
├── oss/                        # OSS-specific modules
│   ├── index.ts
│   ├── discovery/             # Project discovery
│   │   ├── index.ts
│   │   ├── discovery-service.ts
│   │   ├── modes/
│   │   │   ├── direct.ts      # Direct repo list
│   │   │   ├── search.ts      # GitHub search
│   │   │   └── intelligent.ts # AI-powered discovery
│   │   ├── scoring.ts         # Project health scoring
│   │   ├── automated-tools.ts # Detect Sourcery, CodeRabbit, etc.
│   │   └── types.ts
│   ├── selection/             # Issue selection
│   │   ├── index.ts
│   │   ├── selection-service.ts
│   │   ├── filters.ts         # unassigned_no_pr, etc.
│   │   ├── scoring.ts         # Issue scoring
│   │   ├── conflict-detector.ts
│   │   └── types.ts
│   └── quality/               # OSS quality gates
│       ├── index.ts
│       ├── gates.ts           # Rate limits, size limits
│       └── types.ts
│
├── b2b/                        # B2B-specific modules
│   ├── index.ts
│   ├── integrations/          # External service integrations
│   │   ├── index.ts
│   │   ├── jira/
│   │   │   ├── index.ts
│   │   │   ├── client.ts
│   │   │   ├── issue-mapper.ts
│   │   │   └── types.ts
│   │   ├── linear/
│   │   │   ├── index.ts
│   │   │   └── client.ts
│   │   ├── sentry/
│   │   │   ├── index.ts
│   │   │   └── client.ts
│   │   └── interface.ts       # Common issue source interface
│   ├── campaigns/             # Campaign management
│   │   ├── index.ts
│   │   ├── campaign-manager.ts
│   │   ├── campaign-runner.ts
│   │   └── types.ts
│   └── reporting/             # Reports and analytics
│       ├── index.ts
│       ├── report-generator.ts
│       ├── templates/
│       └── types.ts
│
├── infra/                      # Infrastructure utilities
│   ├── index.ts
│   ├── logger.ts              # Structured logging
│   ├── errors.ts              # Error types
│   └── mcp/                   # MCP clients
│       ├── index.ts
│       ├── github.ts
│       └── bitbucket.ts
│
└── types/                      # Shared type definitions
    ├── index.ts
    ├── issue.ts               # Common Issue type
    ├── project.ts             # Common Project type
    ├── session.ts             # Session types
    └── config.ts              # Config types
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

### 1. Integrations (`b2b/integrations/`)

Connect to external issue sources.

```typescript
// interface.ts - Common interface for all issue sources
export interface IssueSource {
  name: string;
  fetchIssues(query: IssueQuery): Promise<Issue[]>;
  updateIssue(id: string, update: IssueUpdate): Promise<void>;
  linkPR(issueId: string, prUrl: string): Promise<void>;
}

// jira/client.ts
export class JiraIssueSource implements IssueSource {
  // Implementation using Jira REST API
}

// linear/client.ts
export class LinearIssueSource implements IssueSource {
  // Implementation using Linear API
}
```

### 2. Campaign Manager (`b2b/campaigns/`)

Batch operations on multiple issues.

```typescript
// campaign-manager.ts
export interface CampaignManager {
  create(config: CampaignConfig): Promise<Campaign>;
  run(campaignId: string): Promise<CampaignResult>;
  pause(campaignId: string): Promise<void>;
  resume(campaignId: string): Promise<void>;
  getStatus(campaignId: string): Promise<CampaignStatus>;
}

export interface CampaignConfig {
  name: string;
  issueSource: IssueSource;
  query: IssueQuery;
  limits: {
    maxIssues: number;
    maxBudget: number;
    maxParallel: number;
  };
  schedule?: CampaignSchedule;
}
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
