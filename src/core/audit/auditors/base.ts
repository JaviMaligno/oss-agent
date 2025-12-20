import { AIProvider } from "../../ai/types.js";
import {
  AuditFinding,
  AuditCategory,
  AuditSeverity,
  AuditConfidence,
} from "../../../types/audit.js";
import { logger } from "../../../infra/logger.js";
import { randomUUID } from "node:crypto";

/**
 * Context provided to auditors during execution
 */
export interface AuditContext {
  runId: string;
  owner: string;
  repo: string;
  repoPath: string;
  aiProvider: AIProvider;
  maxBudgetUsd?: number;
}

/**
 * Base class for category-specific auditors
 *
 * Each auditor is responsible for analyzing a specific aspect of code quality
 * (security, performance, documentation, etc.) and returning findings.
 */
export abstract class BaseAuditor {
  /** The category this auditor handles */
  abstract readonly category: AuditCategory;

  /** Display name for logging */
  abstract readonly displayName: string;

  /**
   * Build the category-specific prompt for AI analysis
   */
  abstract buildPrompt(repoPath: string, context: AuditContext): string;

  /**
   * Get file patterns to focus on for this category
   * Used to help guide the AI toward relevant files
   */
  abstract getFilePatterns(): string[];

  /**
   * Execute the audit and return findings
   */
  async audit(context: AuditContext): Promise<AuditFinding[]> {
    logger.info(`Starting ${this.displayName} audit for ${context.owner}/${context.repo}`);

    try {
      // 1. Build category-specific prompt
      const prompt = this.buildPrompt(context.repoPath, context);

      // 2. Query AI provider
      logger.debug(`Querying AI for ${this.category} issues...`);
      const queryOptions = { cwd: context.repoPath };
      if (context.maxBudgetUsd !== undefined) {
        Object.assign(queryOptions, { maxBudgetUsd: context.maxBudgetUsd });
      }
      const queryResult = await context.aiProvider.query(prompt, queryOptions);

      if (!queryResult.success) {
        logger.error(`AI query failed for ${this.category}: ${queryResult.error}`);
        throw new Error(`AI query failed: ${queryResult.error ?? "Unknown error"}`);
      }

      // 3. Parse response into findings
      logger.debug(`Parsing ${this.category} findings from AI output...`);
      const findings = this.parseFindings(queryResult.output, context);

      // 4. Validate and return findings
      const validFindings = findings.filter((f) => this.validateFinding(f));

      logger.info(
        `${this.displayName} audit complete: ${validFindings.length} findings (${findings.length - validFindings.length} invalid)`
      );

      return validFindings;
    } catch (error) {
      logger.error(`Error during ${this.displayName} audit: ${error}`);
      throw error;
    }
  }

  /**
   * Parse findings from AI output
   * Expects JSON output with findings array
   */
  protected parseFindings(aiOutput: string, context: AuditContext): AuditFinding[] {
    try {
      // Try to extract JSON from the output
      // The AI might wrap JSON in markdown code blocks or add explanation text
      const jsonMatch = aiOutput.match(/\{[\s\S]*"findings"[\s\S]*\]/);
      if (!jsonMatch) {
        logger.warn(`No JSON findings structure found in AI output for ${this.category}`);
        return [];
      }

      const jsonStr = jsonMatch[0] + "}"; // Add closing brace
      const parsed = JSON.parse(jsonStr) as { findings: unknown[] };

      if (!Array.isArray(parsed.findings)) {
        logger.warn(`Findings is not an array in ${this.category} output`);
        return [];
      }

      // Map to AuditFinding objects
      const findings: AuditFinding[] = [];
      for (const rawFinding of parsed.findings) {
        try {
          const finding = this.createFinding(rawFinding as Partial<AuditFinding>, context);
          findings.push(finding);
        } catch (error) {
          logger.warn(`Failed to create finding: ${error}`);
          // Skip invalid findings
        }
      }

      return findings;
    } catch (error) {
      logger.error(`Failed to parse findings JSON for ${this.category}: ${error}`);
      logger.debug(`AI output was: ${aiOutput.slice(0, 500)}...`);
      return [];
    }
  }

  /**
   * Validate a finding has all required fields and valid values
   */
  protected validateFinding(finding: Partial<AuditFinding>): boolean {
    // Check required fields
    if (!finding.title || finding.title.trim().length === 0) {
      logger.debug("Finding missing title");
      return false;
    }

    if (!finding.description || finding.description.trim().length === 0) {
      logger.debug(`Finding "${finding.title}" missing description`);
      return false;
    }

    if (!finding.recommendation || finding.recommendation.trim().length === 0) {
      logger.debug(`Finding "${finding.title}" missing recommendation`);
      return false;
    }

    if (!finding.category || !finding.severity || !finding.confidence) {
      logger.debug(`Finding "${finding.title}" missing category, severity, or confidence`);
      return false;
    }

    // Validate severity
    const validSeverities: AuditSeverity[] = ["critical", "high", "medium", "low", "info"];
    if (!validSeverities.includes(finding.severity as AuditSeverity)) {
      logger.debug(`Finding "${finding.title}" has invalid severity: ${finding.severity}`);
      return false;
    }

    // Validate confidence
    const validConfidences: AuditConfidence[] = ["high", "medium", "low"];
    if (!validConfidences.includes(finding.confidence as AuditConfidence)) {
      logger.debug(`Finding "${finding.title}" has invalid confidence: ${finding.confidence}`);
      return false;
    }

    // Title length check
    if (finding.title.length > 100) {
      logger.debug(
        `Finding title too long (${finding.title.length} chars): ${finding.title.slice(0, 50)}...`
      );
      return false;
    }

    return true;
  }

  /**
   * Create a complete AuditFinding from partial data
   */
  protected createFinding(data: Partial<AuditFinding>, context: AuditContext): AuditFinding {
    const now = new Date();

    // Generate ID if not provided
    const id = data.id ?? `finding-${randomUUID()}`;

    // Ensure required fields are present
    if (!data.title || !data.description || !data.recommendation) {
      throw new Error("Missing required fields: title, description, or recommendation");
    }

    if (!data.severity || !data.confidence) {
      throw new Error("Missing required fields: severity or confidence");
    }

    const finding: AuditFinding = {
      id,
      auditRunId: context.runId,
      category: this.category,
      severity: data.severity,
      confidence: data.confidence,
      title: data.title.trim(),
      description: data.description.trim(),
      recommendation: data.recommendation.trim(),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    // Optional fields
    if (data.filePath) {
      finding.filePath = data.filePath.trim();
    }
    if (data.lineNumber !== undefined) {
      finding.lineNumber = data.lineNumber;
    }
    if (data.codeSnippet) {
      finding.codeSnippet = data.codeSnippet.trim();
    }
    if (data.metadata) {
      finding.metadata = data.metadata;
    }

    return finding;
  }

  /**
   * Convert numeric confidence (0-1) to confidence level
   */
  protected numericToConfidence(value: number): AuditConfidence {
    if (value >= 0.8) return "high";
    if (value >= 0.5) return "medium";
    return "low";
  }

  /**
   * Helper to extract confidence from AI output that might be numeric or string
   */
  protected parseConfidence(value: unknown): AuditConfidence {
    if (typeof value === "number") {
      return this.numericToConfidence(value);
    }
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      if (lower === "high" || lower === "medium" || lower === "low") {
        return lower as AuditConfidence;
      }
    }
    // Default to medium if unclear
    return "medium";
  }
}
