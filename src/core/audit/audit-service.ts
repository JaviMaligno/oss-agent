import { logger } from "../../infra/logger.js";
import { StateManager } from "../state/state-manager.js";
import { GitOperations } from "../git/git-operations.js";
import { AIProvider, QueryOptions } from "../ai/types.js";
import { Config } from "../../types/config.js";
import {
  AuditFinding,
  AuditResult,
  AuditCategory,
  AuditConfig,
  AuditSeverity,
  AuditConfidence,
} from "../../types/audit.js";
import { buildToolBasedAuditPrompt } from "./audit-prompts.js";
import { createAuditMcpServer, getAuditToolNames, type AuditToolResults } from "./audit-tools.js";

/**
 * Options for running an audit
 */
export interface AuditOptions {
  repoUrl: string;
  categories?: AuditCategory[];
  skipIssueCreation?: boolean;
  skipAutoResolve?: boolean;
  minSeverity?: AuditSeverity;
  minConfidence?: AuditConfidence;
}

/**
 * AuditService - Main orchestrator for repository audits
 *
 * Coordinates:
 * - Repository setup and cloning
 * - Category-specific auditor execution
 * - Finding collection and filtering
 * - State persistence
 */
export class AuditService {
  constructor(
    private config: Config,
    private stateManager: StateManager,
    private gitOps: GitOperations,
    private aiProvider: AIProvider
  ) {}

  /**
   * Audit a repository and return findings
   */
  async auditRepository(options: AuditOptions): Promise<AuditResult> {
    const startTime = Date.now();
    logger.header(`Auditing Repository: ${options.repoUrl}`);

    // 1. Parse repository URL and setup
    const { repoPath, owner, repo } = await this.setupRepository(options.repoUrl);
    const projectId = `${owner}/${repo}`;

    // 2. Determine categories to audit
    const categories = options.categories ?? ["security", "documentation", "code-quality"];
    logger.info(`Audit categories: ${categories.join(", ")}`);

    // 3. Create audit run in state
    const auditRun = this.stateManager.createAuditRun({
      projectId,
      categories,
    });
    logger.debug(`Created audit run ${auditRun.id}`);

    try {
      // 4. Run category audits
      logger.step(1, 3, "Running category audits...");
      const allFindings = await this.runCategoryAudits(
        auditRun.id,
        repoPath,
        owner,
        repo,
        categories
      );

      // 5. Filter findings based on options
      logger.step(2, 3, "Filtering findings...");
      const auditConfig: AuditConfig = {
        categories,
        minSeverity: options.minSeverity ?? "medium",
        minConfidence: options.minConfidence ?? "medium",
        issueCreation: {
          mode: options.skipIssueCreation ? "never" : "approve",
          issueLabels: ["audit-finding"],
        },
        security: {
          disclosureMode: "advisory",
          advisorySeverities: ["critical", "high"],
        },
        autoResolve: {
          enabled: !options.skipAutoResolve,
          maxPerRun: 3,
          maxBudgetPerFinding: 5,
        },
        maxBudgetPerAudit: 10,
      };

      const filteredFindings = this.filterFindings(allFindings, auditConfig);
      logger.info(
        `Filtered to ${filteredFindings.length} findings (${allFindings.length - filteredFindings.length} filtered out)`
      );

      // 6. Save findings to state
      logger.step(3, 3, "Saving findings...");
      const savedFindings: AuditFinding[] = [];
      for (const finding of filteredFindings) {
        const saved = this.stateManager.saveAuditFinding(finding);
        savedFindings.push(saved);
      }

      // 7. Calculate summary
      const summary = this.calculateSummary(savedFindings);

      // 8. Complete audit run
      const durationMs = Date.now() - startTime;
      this.stateManager.completeAuditRun(auditRun.id, {
        totalFindings: summary.totalFindings,
        criticalFindings: summary.bySeverity.critical,
        highFindings: summary.bySeverity.high,
        mediumFindings: summary.bySeverity.medium,
        lowFindings: summary.bySeverity.low,
        costUsd: 0, // TODO: Track costs when available
        durationMs,
      });

      // Get updated audit run
      const completedRun = this.stateManager.getAuditRun(auditRun.id);
      if (!completedRun) {
        throw new Error(`Failed to retrieve completed audit run ${auditRun.id}`);
      }

      logger.success(
        `Audit completed in ${(durationMs / 1000).toFixed(1)}s - ${summary.totalFindings} findings`
      );

      return {
        run: completedRun,
        findings: savedFindings,
        summary,
      };
    } catch (error) {
      // Mark audit run as failed
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.stateManager.failAuditRun(auditRun.id, errorMsg);

      logger.error(`Audit failed: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Setup repository by cloning/fetching
   */
  private async setupRepository(
    repoUrl: string
  ): Promise<{ repoPath: string; owner: string; repo: string }> {
    // Parse GitHub URL to extract owner/repo
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);
    if (!match) {
      throw new Error(`Invalid GitHub repository URL: ${repoUrl}`);
    }

    const owner = match[1]!;
    const repo = match[2]!.replace(/\.git$/, "");

    logger.info(`Repository: ${owner}/${repo}`);

    // Clone or update repository
    const cloneResult = await this.gitOps.clone(repoUrl, owner, repo);

    return {
      repoPath: cloneResult.path,
      owner,
      repo,
    };
  }

  /**
   * Run audits for each category
   */
  private async runCategoryAudits(
    runId: string,
    repoPath: string,
    owner: string,
    repo: string,
    categories: AuditCategory[]
  ): Promise<AuditFinding[]> {
    const allFindings: AuditFinding[] = [];

    // For now, we'll use a generic auditor that queries the AI directly
    // In Wave 2B, we'll implement category-specific auditors
    for (const category of categories) {
      logger.info(`Running ${category} audit...`);

      try {
        const findings = await this.runGenericAudit(runId, repoPath, owner, repo, category);
        allFindings.push(...findings);
        logger.info(`${category}: ${findings.length} findings`);
      } catch (error) {
        logger.error(`Failed to run ${category} audit: ${error}`);
        // Continue with other categories
      }
    }

    return allFindings;
  }

  /**
   * Run audit using tool calls to collect findings
   *
   * The AI is given a custom MCP tool (report_audit_finding) that it calls
   * for each issue it discovers. This is more reliable than JSON output parsing.
   *
   * NOTE: This requires SDK mode (ai.executionMode: 'sdk') for custom MCP servers.
   * CLI mode will warn and fall back to prompt-based collection (less reliable).
   */
  private async runGenericAudit(
    runId: string,
    repoPath: string,
    owner: string,
    repo: string,
    category: AuditCategory
  ): Promise<AuditFinding[]> {
    // Check if provider supports custom MCP servers
    const supportsToolCalls = this.aiProvider.capabilities.customMcpServers;

    if (!supportsToolCalls) {
      logger.warn(
        `AI provider '${this.aiProvider.name}' doesn't support custom MCP servers. ` +
          `Audit findings will rely on the AI following prompt instructions. ` +
          `For more reliable results, use SDK mode: oss-agent config set ai.executionMode sdk`
      );
    }

    // Create results collector that the MCP tool will populate
    const results: AuditToolResults = {
      findings: [],
      complete: false,
    };

    // Create custom MCP server with audit tools
    const auditMcpServer = createAuditMcpServer(runId, category, results);

    // Build prompt for this category
    const prompt = buildToolBasedAuditPrompt(owner, repo, category);

    // Build query options
    const queryOptions: QueryOptions = {
      cwd: repoPath,
    };

    // Only add MCP servers and tool restrictions if provider supports them
    if (supportsToolCalls) {
      queryOptions.mcpServers = {
        "audit-tools": auditMcpServer,
      };
      queryOptions.allowedTools = getAuditToolNames();
    }

    // Add budget limit if configured
    const budgetLimit = this.config.budget?.perIssueLimitUsd;
    if (budgetLimit !== undefined) {
      queryOptions.maxBudgetUsd = budgetLimit;
    }

    // Query AI - findings will be collected via tool calls
    const queryResult = await this.aiProvider.query(prompt, queryOptions);

    if (!queryResult.success) {
      throw new Error(`AI query failed: ${queryResult.error ?? "Unknown error"}`);
    }

    // Log audit completion status
    if (supportsToolCalls) {
      if (results.complete) {
        logger.debug(`${category} audit completed normally`);
      } else {
        logger.warn(`${category} audit ended without calling complete_audit tool`);
      }
      logger.info(`${category}: ${results.findings.length} findings collected via tool calls`);
    } else {
      // In non-SDK mode, we can't get structured findings
      logger.info(`${category}: Audit completed (findings collection requires SDK mode)`);
    }

    return results.findings;
  }

  /**
   * Filter findings based on configuration
   */
  private filterFindings(findings: AuditFinding[], config: AuditConfig): AuditFinding[] {
    const severityOrder: Record<AuditSeverity, number> = {
      critical: 5,
      high: 4,
      medium: 3,
      low: 2,
      info: 1,
    };

    const confidenceOrder: Record<AuditConfidence, number> = {
      high: 3,
      medium: 2,
      low: 1,
    };

    const minSeverityLevel = severityOrder[config.minSeverity];
    const minConfidenceLevel = confidenceOrder[config.minConfidence];

    return findings.filter((finding) => {
      // Check severity threshold
      if (severityOrder[finding.severity] < minSeverityLevel) {
        return false;
      }

      // Check confidence threshold
      if (confidenceOrder[finding.confidence] < minConfidenceLevel) {
        return false;
      }

      return true;
    });
  }

  /**
   * Calculate summary statistics from findings
   */
  private calculateSummary(findings: AuditFinding[]): AuditResult["summary"] {
    const summary: AuditResult["summary"] = {
      totalFindings: findings.length,
      bySeverity: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
      },
      byCategory: {
        security: 0,
        performance: 0,
        documentation: 0,
        "code-quality": 0,
        "test-coverage": 0,
      },
      byStatus: {
        pending: 0,
        approved: 0,
        rejected: 0,
        issue_created: 0,
        resolved: 0,
      },
    };

    for (const finding of findings) {
      summary.bySeverity[finding.severity]++;
      summary.byCategory[finding.category]++;
      summary.byStatus[finding.status]++;
    }

    return summary;
  }
}
