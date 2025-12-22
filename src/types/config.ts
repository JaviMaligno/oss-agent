import { z } from "zod";

export const AIConfigSchema = z.object({
  provider: z.literal("claude").default("claude"),
  // Execution mode: "cli" spawns claude process, "sdk" uses API directly
  // CLI mode is default for local dev (uses your existing claude auth)
  // SDK mode requires ANTHROPIC_API_KEY
  executionMode: z.enum(["cli", "sdk"]).default("cli"),
  // Model to use. If not specified, Claude CLI uses its default (best available model)
  model: z.string().optional(),
  apiKey: z.string().optional(),
  // CLI-specific options
  cli: z
    .object({
      // Path to claude CLI binary (default: "claude" from PATH)
      path: z.string().default("claude"),
      // Auto-approve all tool calls (--dangerously-skip-permissions)
      autoApprove: z.boolean().default(true),
      // Max turns for the conversation
      maxTurns: z.number().int().positive().default(50),
    })
    .default({}),
});

export const BudgetConfigSchema = z.object({
  dailyLimitUsd: z.number().positive().default(50),
  monthlyLimitUsd: z.number().positive().default(500),
  perIssueLimitUsd: z.number().positive().default(5),
  perFeedbackIterationUsd: z.number().positive().default(2),
});

export const GitConfigSchema = z.object({
  defaultBranch: z.string().default("main"),
  commitSignoff: z.boolean().default(false),
  branchPrefix: z.string().default("oss-agent"),
  // How to handle existing branches when starting work on an issue
  // - "auto-clean": Delete existing branch and start fresh (default)
  // - "reuse": Reuse existing branch if found
  // - "suffix": Create a new branch with numeric suffix (e.g., branch-2, branch-3)
  // - "fail": Fail if branch already exists
  existingBranchStrategy: z.enum(["auto-clean", "reuse", "suffix", "fail"]).default("auto-clean"),
});

export const CICheckConfigSchema = z.object({
  // Whether to wait for CI checks after PR creation
  waitForChecks: z.boolean().default(true),
  // Whether to auto-fix failed CI checks
  autoFixFailedChecks: z.boolean().default(true),
  // Timeout for CI checks to complete (ms) - default 30 minutes
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
  // Interval between polling CI status (ms) - default 30 seconds
  pollIntervalMs: z
    .number()
    .int()
    .positive()
    .default(30 * 1000),
  // Initial delay before first poll (ms) - allows GitHub Actions to register
  // Default 15 seconds to give GitHub time to create check runs after PR creation
  initialDelayMs: z
    .number()
    .int()
    .nonnegative()
    .default(15 * 1000),
  // Maximum iterations for CI fix attempts
  maxFixIterations: z.number().int().positive().default(3),
  // Maximum budget per fix attempt (USD)
  maxBudgetPerFix: z.number().positive().default(2),
  // Specific checks to wait for (optional, waits for all if not specified)
  requiredChecks: z.array(z.string()).optional(),
});

export const ReviewConfigSchema = z.object({
  // Whether to run automated review after CI passes
  enabled: z.boolean().default(true),
  // Whether to post approval/request-changes verdict (false = comments only)
  // Default false to avoid automated approval without human review
  postApproval: z.boolean().default(false),
  // Whether to auto-fix issues found during review
  autoFix: z.boolean().default(true),
  // Whether to post review comments on the PR
  postComment: z.boolean().default(true),
  // Maximum budget per review (USD)
  maxBudgetUsd: z.number().positive().default(2),
});

export const QualityGatesSchema = z.object({
  maxPrsPerProjectPerDay: z.number().int().positive().default(2),
  maxPrsPerDay: z.number().int().positive().default(10),
  maxFilesChanged: z.number().int().positive().default(20),
  maxLinesChanged: z.number().int().positive().default(500),
  requireTestsPass: z.boolean().default(true),
  requireLintPass: z.boolean().default(true),
  // Maximum iterations for local test fix loop before pushing
  // This runs BEFORE pushing to catch issues early
  maxLocalTestFixIterations: z.number().int().positive().default(3),
  // CI check configuration (optional)
  ciChecks: CICheckConfigSchema.optional(),
  // Automated review configuration (optional)
  review: ReviewConfigSchema.optional(),
});

export const QueueConfigSchema = z.object({
  // Trigger replenishment when queue size falls below this
  minQueueSize: z.number().int().nonnegative().default(5),
  // Replenish up to this many issues
  targetQueueSize: z.number().int().positive().default(20),
  // Automatically replenish queue when it runs low
  autoReplenish: z.boolean().default(true),
});

export const OSSConfigSchema = z.object({
  discoveryMode: z.enum(["direct", "search", "intelligent"]).default("direct"),
  directRepos: z.array(z.string()).default([]),
  filterLabels: z.array(z.string()).default(["good first issue", "help wanted"]),
  excludeLabels: z.array(z.string()).default(["wontfix", "duplicate", "invalid"]),
  minStars: z.number().int().nonnegative().default(100),
  maxStars: z.number().int().positive().default(50000),
  requireNoExistingPR: z.boolean().default(true),
  qualityGates: QualityGatesSchema.default({}),
  queue: QueueConfigSchema.default({}),
});

// === Repository Provider Configurations ===

export const GitHubEnterpriseConfigSchema = z.object({
  // Base URL for the GitHub Enterprise instance
  baseUrl: z.string().url(),
  // API URL (defaults to baseUrl/api/v3)
  apiUrl: z.string().url().optional(),
  // Personal access token (can also use GH_ENTERPRISE_TOKEN env var)
  token: z.string().optional(),
});

export const GitLabConfigSchema = z.object({
  // Base URL (defaults to gitlab.com)
  baseUrl: z.string().url().default("https://gitlab.com"),
  // Personal access token (can also use GITLAB_TOKEN env var)
  token: z.string().optional(),
  // Whether to prefer glab CLI if available
  preferCli: z.boolean().default(true),
});

export const BitbucketConfigSchema = z.object({
  // Bitbucket workspace
  workspace: z.string(),
  // Base URL (defaults to bitbucket.org)
  baseUrl: z.string().url().default("https://bitbucket.org"),
  // App password (can also use BITBUCKET_APP_PASSWORD env var)
  appPassword: z.string().optional(),
  // Bitbucket username
  username: z.string().optional(),
});

// === Issue Source Provider Configurations ===

export const JiraConfigSchema = z.object({
  // Jira instance URL
  baseUrl: z.string().url(),
  // User email for authentication
  email: z.string().email(),
  // API token
  apiToken: z.string(),
  // Default project key
  projectKey: z.string(),
  // Cloud ID (for Jira Cloud)
  cloudId: z.string().optional(),
  // Whether this is Jira Server/Data Center (vs Cloud)
  isServer: z.boolean().default(false),
  // Default JQL filter for issue queries
  jqlFilter: z.string().optional(),
  // Status mapping: Jira status name -> internal IssueState
  statusMapping: z.record(z.string()).optional(),
  // Custom field IDs
  customFields: z
    .object({
      storyPoints: z.string().optional(),
      sprint: z.string().optional(),
      epicLink: z.string().optional(),
    })
    .optional(),
  // Transition IDs for status updates
  transitions: z
    .object({
      inProgress: z.string().optional(),
      done: z.string().optional(),
      closed: z.string().optional(),
    })
    .optional(),
});

export const LinearConfigSchema = z.object({
  // Linear API key
  apiKey: z.string(),
  // Team ID
  teamId: z.string(),
  // Project ID (optional)
  projectId: z.string().optional(),
  // Cycle ID (optional)
  cycleId: z.string().optional(),
  // Filter by state names
  stateFilter: z.array(z.string()).optional(),
  // Filter by priority (0=urgent, 1=high, 2=medium, 3=low, 4=none)
  priorityFilter: z.array(z.number().int().min(0).max(4)).optional(),
  // Filter by label names
  labelFilter: z.array(z.string()).optional(),
  // Auto-close issue when PR is merged
  autoCloseOnMerge: z.boolean().default(true),
});

export const SentryConfigSchema = z.object({
  // Sentry organization slug
  organizationSlug: z.string(),
  // Sentry project slug (optional, for filtering)
  projectSlug: z.string().optional(),
  // Auth token
  authToken: z.string(),
  // DSN (optional, for error tracking)
  dsn: z.string().optional(),
  // Minimum occurrences to consider as issue
  minOccurrences: z.number().int().positive().default(5),
  // Minimum affected users
  minUsers: z.number().int().nonnegative().default(1),
  // Exclude handled errors
  excludeHandled: z.boolean().default(true),
  // Issue statuses to include
  issueStatuses: z.array(z.enum(["unresolved", "resolved", "ignored"])).default(["unresolved"]),
  // Auto-resolve when PR merged
  autoResolve: z.boolean().default(true),
});

// === Sync Configuration ===

export const SyncConfigSchema = z.object({
  // How often to poll for updates (ms)
  pollIntervalMs: z.number().int().positive().default(60000),
  // Enable webhook listener
  enableWebhooks: z.boolean().default(false),
  // Webhook server port
  webhookPort: z.number().int().positive().default(3456),
  // Update external system when state changes
  pushUpdates: z.boolean().default(true),
});

// === B2B Configuration ===

export const B2BConfigSchema = z.object({
  // Issue source provider
  issueSource: z.enum(["jira", "linear", "sentry", "github"]).default("github"),

  // Repository provider (auto-detected from URLs, but can be forced)
  repositoryProvider: z.enum(["github", "github-enterprise", "gitlab", "bitbucket"]).optional(),

  // Provider configurations
  jira: JiraConfigSchema.optional(),
  linear: LinearConfigSchema.optional(),
  sentry: SentryConfigSchema.optional(),
  githubEnterprise: GitHubEnterpriseConfigSchema.optional(),
  gitlab: GitLabConfigSchema.optional(),
  bitbucket: BitbucketConfigSchema.optional(),

  // Sync configuration
  sync: SyncConfigSchema.default({}),

  // Default repository for B2B mode (owner/repo format)
  // Used when issues don't have repository context
  defaultRepository: z.string().optional(),
});

export const LoggingConfigSchema = z.object({
  // Directory for log files (relative to dataDir)
  dir: z.string().default("logs"),
  // Keep logs for N days
  retentionDays: z.number().int().positive().default(30),
  // Log level for file output
  fileLevel: z.enum(["debug", "info", "warn", "error"]).default("debug"),
  // Log level for console output
  consoleLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const ParallelConfigSchema = z.object({
  // Maximum concurrent agents (global limit)
  maxConcurrentAgents: z.number().int().positive().default(3),
  // Maximum concurrent agents per project
  maxConcurrentPerProject: z.number().int().positive().default(2),
  // Maximum total worktrees to maintain
  maxWorktrees: z.number().int().positive().default(10),
  // Maximum worktrees per project
  maxWorktreesPerProject: z.number().int().positive().default(5),
  // Auto-cleanup completed worktrees after N hours
  autoCleanupHours: z.number().int().positive().default(24),
  // Enable conflict detection between parallel issues
  enableConflictDetection: z.boolean().default(true),
});

// === Hardening Configuration ===

export const RetryConfigSchema = z.object({
  // Maximum number of retry attempts
  maxRetries: z.number().int().nonnegative().default(3),
  // Base delay in milliseconds for exponential backoff
  baseDelayMs: z.number().int().positive().default(1000),
  // Maximum delay in milliseconds
  maxDelayMs: z.number().int().positive().default(30000),
  // Whether to add jitter to prevent thundering herd
  enableJitter: z.boolean().default(true),
});

export const CircuitBreakerConfigSchema = z.object({
  // Number of consecutive failures before opening circuit
  failureThreshold: z.number().int().positive().default(5),
  // Number of successes in half-open state before closing
  successThreshold: z.number().int().positive().default(2),
  // How long to stay open before transitioning to half-open (ms)
  openDurationMs: z.number().int().positive().default(60000),
});

export const HealthCheckConfigSchema = z.object({
  // How often to run health checks (ms)
  intervalMs: z.number().int().positive().default(60000),
  // Disk space warning threshold in GB
  diskWarningThresholdGb: z.number().positive().default(1.0),
  // Disk space critical threshold in GB
  diskCriticalThresholdGb: z.number().positive().default(0.5),
  // Memory warning threshold in MB (available memory)
  memoryWarningThresholdMb: z.number().positive().default(100),
});

export const WatchdogConfigSchema = z.object({
  // Timeout for AI operations (ms)
  aiOperationTimeoutMs: z.number().int().positive().default(300000), // 5 min
  // Timeout for git operations (ms)
  gitOperationTimeoutMs: z.number().int().positive().default(60000), // 1 min
});

export const HardeningConfigSchema = z.object({
  retry: RetryConfigSchema.default({}),
  circuitBreaker: CircuitBreakerConfigSchema.default({}),
  healthCheck: HealthCheckConfigSchema.default({}),
  watchdog: WatchdogConfigSchema.default({}),
});

// === MCP Server Configuration ===

export const MCPStdioTransportSchema = z.object({
  enabled: z.boolean().default(true),
});

export const MCPHttpCorsSchema = z.object({
  enabled: z.boolean().default(false),
  origins: z.array(z.string()).default(["http://localhost:*"]),
});

export const MCPHttpTransportSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().positive().default(3000),
  host: z.string().default("127.0.0.1"),
  // Require API key auth for HTTP transport
  requireAuth: z.boolean().default(true),
  cors: MCPHttpCorsSchema.default({}),
});

export const MCPTransportsSchema = z.object({
  stdio: MCPStdioTransportSchema.default({}),
  http: MCPHttpTransportSchema.default({}),
});

export const MCPAuthSchema = z.object({
  // API keys for HTTP transport (plaintext in config)
  apiKeys: z.array(z.string()).default([]),
  // Path to API keys file (one per line, alternative to inline keys)
  apiKeysFile: z.string().optional(),
});

export const MCPRateLimitSchema = z.object({
  enabled: z.boolean().default(true),
  // Max requests per minute per client
  maxRequestsPerMinute: z.number().int().positive().default(60),
  // Max concurrent long-running operations (work, iterate, run)
  maxConcurrentOps: z.number().int().positive().default(3),
});

export const MCPToolsSchema = z.object({
  // Disable specific tools by name (e.g., ["update_config", "cleanup_worktrees"])
  disabled: z.array(z.string()).default([]),
  // Per-tool timeout overrides in milliseconds
  timeouts: z.record(z.number().int().positive()).default({
    work_on_issue: 600000, // 10 min
    iterate_on_feedback: 300000, // 5 min
    run_autonomous: 3600000, // 1 hour
    discover_projects: 120000, // 2 min
  }),
});

export const MCPConfigSchema = z.object({
  // Enable MCP server mode
  enabled: z.boolean().default(false),
  // Transport configurations
  transports: MCPTransportsSchema.default({}),
  // Authentication configuration
  auth: MCPAuthSchema.default({}),
  // Rate limiting configuration
  rateLimit: MCPRateLimitSchema.default({}),
  // Tool-specific configuration
  tools: MCPToolsSchema.default({}),
});

// === Audit Configuration (Phase 7.1) ===

export const AuditConfigSchema = z.object({
  categories: z
    .array(z.enum(["security", "performance", "documentation", "code-quality", "test-coverage"]))
    .default(["security", "documentation", "code-quality"]),
  minSeverity: z.enum(["critical", "high", "medium", "low", "info"]).default("medium"),
  minConfidence: z.enum(["high", "medium", "low"]).default("medium"),
  issueCreation: z
    .object({
      mode: z.enum(["auto", "approve", "never"]).default("approve"),
      autoCreateSeverities: z
        .array(z.enum(["critical", "high", "medium", "low", "info"]))
        .optional(),
      issueLabels: z.array(z.string()).default(["audit-finding"]),
    })
    .default({}),
  security: z
    .object({
      disclosureMode: z.enum(["advisory", "private-issue", "public-issue"]).default("advisory"),
      advisorySeverities: z
        .array(z.enum(["critical", "high", "medium", "low", "info"]))
        .default(["critical", "high"]),
    })
    .default({}),
  autoResolve: z
    .object({
      enabled: z.boolean().default(false),
      categories: z
        .array(
          z.enum(["security", "performance", "documentation", "code-quality", "test-coverage"])
        )
        .optional(),
      maxPerRun: z.number().int().positive().default(3),
      maxBudgetPerFinding: z.number().positive().default(5),
    })
    .default({}),
  maxBudgetPerAudit: z.number().positive().default(10),
});

export const ConfigSchema = z.object({
  ai: AIConfigSchema.default({}),
  budget: BudgetConfigSchema.default({}),
  git: GitConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  parallel: ParallelConfigSchema.default({}),
  hardening: HardeningConfigSchema.default({}),
  mcp: MCPConfigSchema.optional(),
  audit: AuditConfigSchema.default({}),
  mode: z.enum(["oss", "b2b"]).default("oss"),
  oss: OSSConfigSchema.optional(),
  b2b: B2BConfigSchema.optional(),
  dataDir: z.string().default("~/.oss-agent"),
  verbose: z.boolean().default(false),
});

export type AIConfig = z.infer<typeof AIConfigSchema>;
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
export type GitConfig = z.infer<typeof GitConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type ParallelConfig = z.infer<typeof ParallelConfigSchema>;
export type CICheckConfig = z.infer<typeof CICheckConfigSchema>;
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;
export type QualityGates = z.infer<typeof QualityGatesSchema>;
export type QueueConfig = z.infer<typeof QueueConfigSchema>;
export type OSSConfig = z.infer<typeof OSSConfigSchema>;
export type B2BConfig = z.infer<typeof B2BConfigSchema>;
export type AuditConfig = z.infer<typeof AuditConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

// Provider configuration types
export type GitHubEnterpriseConfig = z.infer<typeof GitHubEnterpriseConfigSchema>;
export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;
export type BitbucketConfig = z.infer<typeof BitbucketConfigSchema>;
export type JiraConfig = z.infer<typeof JiraConfigSchema>;
export type LinearConfig = z.infer<typeof LinearConfigSchema>;
export type SentryConfig = z.infer<typeof SentryConfigSchema>;
export type SyncConfig = z.infer<typeof SyncConfigSchema>;

// Hardening configuration types
export type RetryConfig = z.infer<typeof RetryConfigSchema>;
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;
export type HealthCheckConfig = z.infer<typeof HealthCheckConfigSchema>;
export type WatchdogConfig = z.infer<typeof WatchdogConfigSchema>;
export type HardeningConfig = z.infer<typeof HardeningConfigSchema>;

// MCP configuration types
export type MCPStdioTransport = z.infer<typeof MCPStdioTransportSchema>;
export type MCPHttpCors = z.infer<typeof MCPHttpCorsSchema>;
export type MCPHttpTransport = z.infer<typeof MCPHttpTransportSchema>;
export type MCPTransports = z.infer<typeof MCPTransportsSchema>;
export type MCPAuth = z.infer<typeof MCPAuthSchema>;
export type MCPRateLimit = z.infer<typeof MCPRateLimitSchema>;
export type MCPTools = z.infer<typeof MCPToolsSchema>;
export type MCPConfig = z.infer<typeof MCPConfigSchema>;
