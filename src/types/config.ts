import { z } from "zod";

export const AIConfigSchema = z.object({
  provider: z.literal("claude").default("claude"),
  // Execution mode: "cli" spawns claude process, "sdk" uses API directly
  // CLI mode is default for local dev (uses your existing claude auth)
  // SDK mode requires ANTHROPIC_API_KEY
  executionMode: z.enum(["cli", "sdk"]).default("cli"),
  model: z.string().default("claude-sonnet-4-20250514"),
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

export const QualityGatesSchema = z.object({
  maxPrsPerProjectPerDay: z.number().int().positive().default(2),
  maxPrsPerDay: z.number().int().positive().default(10),
  maxFilesChanged: z.number().int().positive().default(20),
  maxLinesChanged: z.number().int().positive().default(500),
  requireTestsPass: z.boolean().default(true),
  requireLintPass: z.boolean().default(true),
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
});

export const B2BConfigSchema = z.object({
  issueSource: z.enum(["jira", "linear", "sentry", "github"]).default("github"),
  jira: z
    .object({
      baseUrl: z.string().url(),
      email: z.string().email(),
      apiToken: z.string(),
      projectKey: z.string(),
    })
    .optional(),
  linear: z
    .object({
      apiKey: z.string(),
      teamId: z.string(),
    })
    .optional(),
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

export const ConfigSchema = z.object({
  ai: AIConfigSchema.default({}),
  budget: BudgetConfigSchema.default({}),
  git: GitConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  parallel: ParallelConfigSchema.default({}),
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
export type QualityGates = z.infer<typeof QualityGatesSchema>;
export type OSSConfig = z.infer<typeof OSSConfigSchema>;
export type B2BConfig = z.infer<typeof B2BConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
