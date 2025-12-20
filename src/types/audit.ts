import { z } from "zod";

// ============ Enums ============

/**
 * Category of audit finding
 */
export type AuditCategory =
  | "security"
  | "performance"
  | "documentation"
  | "code-quality"
  | "test-coverage";

/**
 * Severity level of audit finding
 */
export type AuditSeverity = "critical" | "high" | "medium" | "low" | "info";

/**
 * Confidence level in the finding
 */
export type AuditConfidence = "high" | "medium" | "low";

/**
 * Status of an audit finding
 */
export type AuditFindingStatus = "pending" | "approved" | "rejected" | "issue_created" | "resolved";

/**
 * Status of an audit run
 */
export type AuditRunStatus = "in_progress" | "completed" | "failed" | "cancelled";

// ============ Zod Schemas ============

/**
 * Schema for audit finding
 */
export const AuditFindingSchema = z.object({
  id: z.string(),
  auditRunId: z.string(),
  category: z.enum(["security", "performance", "documentation", "code-quality", "test-coverage"]),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  confidence: z.enum(["high", "medium", "low"]),
  title: z.string(),
  description: z.string(),
  filePath: z.string().optional(),
  lineNumber: z.number().int().positive().optional(),
  codeSnippet: z.string().optional(),
  recommendation: z.string(),
  status: z
    .enum(["pending", "approved", "rejected", "issue_created", "resolved"])
    .default("pending"),
  issueUrl: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Schema for audit run
 */
export const AuditRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  startedAt: z.date(),
  completedAt: z.date().optional(),
  status: z.enum(["in_progress", "completed", "failed", "cancelled"]),
  categories: z.array(
    z.enum(["security", "performance", "documentation", "code-quality", "test-coverage"])
  ),
  totalFindings: z.number().int().nonnegative().default(0),
  criticalFindings: z.number().int().nonnegative().default(0),
  highFindings: z.number().int().nonnegative().default(0),
  mediumFindings: z.number().int().nonnegative().default(0),
  lowFindings: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

/**
 * Schema for audit configuration
 */
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

// ============ TypeScript Types ============

/**
 * Individual audit finding
 */
export interface AuditFinding {
  id: string;
  auditRunId: string;
  category: AuditCategory;
  severity: AuditSeverity;
  confidence: AuditConfidence;
  title: string;
  description: string;
  filePath?: string;
  lineNumber?: number;
  codeSnippet?: string;
  recommendation: string;
  status: AuditFindingStatus;
  issueUrl?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Audit execution record
 */
export interface AuditRun {
  id: string;
  projectId: string;
  startedAt: Date;
  completedAt?: Date;
  status: AuditRunStatus;
  categories: AuditCategory[];
  totalFindings: number;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  lowFindings: number;
  costUsd: number;
  durationMs?: number;
  error?: string;
}

/**
 * Complete audit result
 */
export interface AuditResult {
  run: AuditRun;
  findings: AuditFinding[];
  summary: {
    totalFindings: number;
    bySeverity: Record<AuditSeverity, number>;
    byCategory: Record<AuditCategory, number>;
    byStatus: Record<AuditFindingStatus, number>;
  };
}

/**
 * Audit configuration
 */
export interface AuditConfig {
  categories: AuditCategory[];
  minSeverity: AuditSeverity;
  minConfidence: AuditConfidence;
  issueCreation: {
    mode: "auto" | "approve" | "never";
    autoCreateSeverities?: AuditSeverity[];
    issueLabels: string[];
  };
  security: {
    disclosureMode: "advisory" | "private-issue" | "public-issue";
    advisorySeverities: AuditSeverity[];
  };
  autoResolve: {
    enabled: boolean;
    categories?: AuditCategory[];
    maxPerRun: number;
    maxBudgetPerFinding: number;
  };
  maxBudgetPerAudit: number;
}

// ============ Filter Types ============

/**
 * Filters for querying audit findings
 */
export interface AuditFindingFilters {
  status?: AuditFindingStatus | AuditFindingStatus[];
  severity?: AuditSeverity | AuditSeverity[];
  category?: AuditCategory | AuditCategory[];
  minConfidence?: AuditConfidence;
}

/**
 * Filters for querying audit runs
 */
export interface AuditRunFilters {
  status?: AuditRunStatus | AuditRunStatus[];
  projectId?: string;
  categories?: AuditCategory[];
}

// Export Zod type inference
export type AuditFindingType = z.infer<typeof AuditFindingSchema>;
export type AuditRunType = z.infer<typeof AuditRunSchema>;
export type AuditConfigType = z.infer<typeof AuditConfigSchema>;
