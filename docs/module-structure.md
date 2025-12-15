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
│   │   ├── claude-sdk-provider.ts  # Claude SDK implementation (API-based)
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
│   ├── errors.ts              # Custom error types (NetworkError, TimeoutError, CircuitOpenError, etc.)
│   ├── retry.ts               # Retry with exponential backoff and jitter
│   ├── circuit-breaker.ts     # Circuit breaker pattern for cascading failure prevention
│   ├── watchdog.ts            # Watchdog timer for hung operation detection
│   ├── health-check.ts        # Health monitoring (disk, memory, AI availability)
│   └── cleanup-manager.ts     # Resource cleanup with graceful shutdown
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
├── cli/
│   ├── helpers.ts             # Test utilities (createTestEnvironment, mocks)
│   ├── status.test.ts         # Status command dependency tests
│   ├── queue.test.ts          # Queue command dependency tests
│   └── history.test.ts        # History command dependency tests
├── core/
│   ├── ai-provider.test.ts    # AI provider tests
│   ├── feedback-parser.test.ts # Feedback parsing tests
│   ├── git-operations.test.ts # Git operations tests
│   ├── state-manager.test.ts  # State manager tests
│   ├── worktree-manager.test.ts # Worktree manager tests
│   ├── parallel-orchestrator.test.ts # Parallel orchestration tests
│   └── providers.test.ts      # Provider URL parsing tests (Phase 6)
├── b2b/
│   └── campaign-service.test.ts # Campaign service tests (Phase 6)
├── infra/
│   ├── logger.test.ts         # Logger tests
│   ├── semaphore.test.ts      # Semaphore tests
│   ├── repo-lock.test.ts      # Repository lock tests
│   ├── retry.test.ts          # Retry with backoff tests
│   ├── circuit-breaker.test.ts # Circuit breaker tests
│   ├── watchdog.test.ts       # Watchdog timer tests
│   ├── health-check.test.ts   # Health check tests
│   └── cleanup-manager.test.ts # Cleanup manager tests
├── oss/
│   └── search-agent.test.ts   # Search agent tests
└── types/
    └── config.test.ts         # Config validation tests
```

### MCP Server Structure (Phase 7.3)

```
src/mcp/                        # MCP Server Mode
├── index.ts                   # Module exports
├── server.ts                  # MCP Server implementation
├── types.ts                   # MCP-specific types
├── hardening.ts               # Circuit breaker & watchdog integration
├── transports/
│   ├── stdio-transport.ts     # Stdio transport (Claude Desktop/Code)
│   └── http-transport.ts      # HTTP/SSE transport
├── tools/
│   ├── index.ts               # Tool registry
│   ├── workflow-tools.ts      # work_on_issue, iterate, resume, watch
│   ├── discovery-tools.ts     # discover_projects, suggest_issues
│   ├── queue-tools.ts         # queue_list, add, remove, prioritize, clear
│   ├── autonomous-tools.ts    # run_autonomous, work_parallel, cancel, status
│   ├── monitoring-tools.ts    # get_pr_status, get_session_history, get_status
│   └── management-tools.ts    # get_config, update_config, cleanup_worktrees
├── resources/
│   └── index.ts               # Resource registry (config://, state://, queue://)
└── middleware/
    ├── auth.ts                # API key authentication
    ├── rate-limit.ts          # Request throttling
    └── error-handler.ts       # Error mapping to MCP errors
```

### Planned Structure (Future)

```
src/
├── cli/commands/
│   └── report.ts              # oss-agent report (analytics)
│
├── oss/
│   └── quality/               # OSS quality gates (enhanced)
│
└── b2b/
    └── reporting/             # Reports and analytics engine
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

## Infrastructure Layer Detail

### Hardening Modules (`infra/`)

Production reliability infrastructure added in Phase 7.4.

#### 1. Retry with Exponential Backoff (`infra/retry.ts`)

```typescript
// retry.ts
export function retry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T>;

export function retryWithRateLimit<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T>;

export function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean
): number;

export interface RetryOptions {
  maxRetries?: number;      // Default: 3
  baseDelayMs?: number;     // Default: 1000ms
  maxDelayMs?: number;      // Default: 30000ms
  jitter?: boolean;         // Default: true (adds 0-25% random jitter)
  shouldRetry?: (error: Error) => boolean;
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}
```

#### 2. Circuit Breaker (`infra/circuit-breaker.ts`)

Prevents cascading failures by stopping requests to failing services.

```typescript
// circuit-breaker.ts
export class CircuitBreaker {
  execute<T>(fn: () => Promise<T>): Promise<T>;
  getState(): "closed" | "open" | "half-open";
  reset(): void;
  trip(): void;
}

export class CircuitBreakerRegistry {
  static getInstance(): CircuitBreakerRegistry;
  get(operationType: string, options?: CircuitBreakerOptions): CircuitBreaker;
  getStatus(): Record<string, CircuitStatus>;
  resetAll(): void;
}

export const CIRCUIT_OPERATIONS = {
  AI_PROVIDER: "ai-provider",
  GITHUB_API: "github-api",
  GIT_OPERATIONS: "git-operations",
} as const;
```

**State Machine:**
```
closed → (failures >= threshold) → open
open → (after openDurationMs) → half-open
half-open → (success) → closed
half-open → (failure) → open
```

#### 3. Watchdog Timer (`infra/watchdog.ts`)

Detects hung operations and triggers timeout callbacks.

```typescript
// watchdog.ts
export class Watchdog {
  start(metadata?: Record<string, unknown>): void;
  heartbeat(): void;
  stop(): void;
  isRunning(): boolean;
  getElapsedMs(): number;
}

export function createAIOperationWatchdog(
  onTimeout: (context: WatchdogContext) => void,
  timeoutMs?: number  // Default: 5 minutes
): Watchdog;

export function createGitOperationWatchdog(
  onTimeout: (context: WatchdogContext) => void,
  timeoutMs?: number  // Default: 1 minute
): Watchdog;

export function withWatchdog<T>(
  operationType: string,
  fn: (heartbeat: () => void) => Promise<T>,
  options: WatchdogOptions
): Promise<T>;
```

#### 4. Health Check (`infra/health-check.ts`)

Monitors system health during long-running operations.

```typescript
// health-check.ts
export class HealthChecker {
  check(): Promise<HealthCheckResult>;
  startPeriodic(): () => void;  // Returns stop function
  setAIProvider(provider: AIProvider): void;
}

export interface HealthCheckResult {
  timestamp: Date;
  overallStatus: "healthy" | "warning" | "critical";
  checks: {
    disk: CheckResult;
    memory: CheckResult;
    aiProvider?: CheckResult;
    worktrees?: CheckResult;
  };
}
```

**Checks performed:**
- Disk space (warning: <1GB, critical: <500MB)
- Memory usage (warning: >85%, critical: >95%)
- AI provider availability (if configured)
- Active worktree count (warning: >5)

#### 5. Cleanup Manager (`infra/cleanup-manager.ts`)

Manages resource cleanup on shutdown with graceful handling.

```typescript
// cleanup-manager.ts
export class CleanupManager {
  static getInstance(): CleanupManager;

  register(task: CleanupTask): string;  // Returns task ID
  unregister(taskId: string): boolean;
  runAll(): Promise<CleanupResult>;
  installShutdownHandlers(): void;  // SIGINT, SIGTERM
}

// Helper functions for common cleanup tasks
export function registerWorktreeCleanup(
  repoPath: string,
  worktreePath: string
): string;

export function registerTempFileCleanup(filePath: string): string;

export function registerProcessCleanup(
  pid: number,
  signal?: NodeJS.Signals
): string;
```

### Configuration (`types/config.ts`)

Hardening configuration schema:

```typescript
export interface HardeningConfig {
  retry?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    enableJitter?: boolean;
  };
  circuitBreaker?: {
    failureThreshold?: number;
    successThreshold?: number;
    openDurationMs?: number;
  };
  healthCheck?: {
    intervalMs?: number;
    diskWarningThresholdGb?: number;
    diskCriticalThresholdGb?: number;
  };
  watchdog?: {
    aiOperationTimeoutMs?: number;
  };
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

---

## MCP Server Mode Detail

The MCP (Model Context Protocol) server exposes oss-agent capabilities as tools for Claude Desktop, Claude Code, or other MCP-compatible clients.

### Usage

```bash
# Stdio mode (for Claude Desktop/Code integration)
oss-agent serve --stdio

# HTTP mode (for remote access)
oss-agent serve --http --port 3000

# HTTP with authentication
oss-agent serve --http --port 3000 --api-key "sk-your-key"

# Both transports
oss-agent serve --stdio --http --port 3000
```

### MCP Tools (19 total)

| Category | Tool | Description |
|----------|------|-------------|
| **Workflow** | `work_on_issue` | Complete issue→PR workflow |
| | `iterate_on_feedback` | Address PR review feedback |
| | `resume_session` | Resume interrupted session |
| | `watch_prs` | Monitor PRs, auto-iterate |
| **Discovery** | `discover_projects` | Find OSS projects |
| | `suggest_issues` | Suggest issues to work on |
| **Queue** | `queue_list` | List queued issues |
| | `queue_add` | Add issue to queue |
| | `queue_remove` | Remove from queue |
| | `queue_prioritize` | Change priority |
| | `queue_clear` | Clear entire queue |
| **Autonomous** | `run_autonomous` | Autonomous mode |
| | `work_parallel` | Parallel issue work |
| | `cancel_work` | Cancel work on issue |
| | `parallel_status` | Show parallel status |
| **Monitoring** | `get_pr_status` | PR details with feedback |
| | `get_session_history` | Session list |
| | `get_status` | System status & health |
| **Management** | `get_config` | Read configuration |
| | `update_config` | Update configuration |
| | `cleanup_worktrees` | Clean old worktrees |

### MCP Resources

| URI Pattern | Description |
|-------------|-------------|
| `config://current` | Current configuration |
| `config://defaults` | Default configuration values |
| `state://issues` | Query issues by state |
| `state://sessions` | Query sessions |
| `queue://current` | Queue contents |
| `queue://stats` | Queue statistics |

### Hardening (`mcp/hardening.ts`)

Long-running tools are wrapped with resilience patterns:

```typescript
// Circuit breaker prevents cascading failures
const hardenedHandler = hardenToolHandler("work_on_issue", handler, {
  circuitBreakerEnabled: true,
  watchdogEnabled: true,
  circuitBreaker: {
    failureThreshold: 3,     // Open after 3 failures
    successThreshold: 2,     // Close after 2 successes
    openDurationMs: 60000,   // Stay open for 1 minute
  },
  toolTimeouts: {
    work_on_issue: 600000,   // 10 minutes
    run_autonomous: 1800000, // 30 minutes
  },
});

// Get health status
const healthy = isMCPHealthy();           // true if all circuits closed
const status = getMCPCircuitStatus();     // Per-tool circuit states

// Reset all circuits
resetAllMCPCircuits();
```

### HTTP Transport Features

- **Authentication**: API key via `Authorization: Bearer <key>` header
- **Rate Limiting**: Sliding window algorithm, per-client tracking
- **CORS**: Configurable origins with wildcard support
- **Health Endpoints**: `/health`, `/ready`, `/stats`

### Configuration

```yaml
# In ~/.oss-agent/config.json
{
  "mcp": {
    "enabled": true,
    "transports": {
      "stdio": { "enabled": true },
      "http": {
        "enabled": true,
        "port": 3000,
        "host": "127.0.0.1",
        "requireAuth": true,
        "cors": {
          "enabled": true,
          "origins": ["http://localhost:*"]
        }
      }
    },
    "auth": {
      "apiKeys": ["sk-your-key"],
      "apiKeysFile": "~/.oss-agent/api-keys.txt"
    },
    "rateLimit": {
      "enabled": true,
      "maxRequestsPerMinute": 60,
      "maxConcurrentOps": 3
    },
    "tools": {
      "disabled": ["run_autonomous"],
      "timeouts": {
        "work_on_issue": 600000
      }
    }
  }
}
```

### Claude Desktop Integration

Add to `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "oss-agent": {
      "command": "oss-agent",
      "args": ["serve", "--stdio"]
    }
  }
}
```
