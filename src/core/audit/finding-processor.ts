import { spawn } from "node:child_process";
import { logger } from "../../infra/logger.js";
import { StateManager } from "../state/state-manager.js";
import { AuditFinding, AuditConfig } from "../../types/audit.js";

export interface ProcessedFinding {
  finding: AuditFinding;
  issueCreated: boolean;
  issueUrl?: string;
  error?: string;
}

/**
 * FindingProcessor - Converts audit findings into GitHub issues
 *
 * Responsibilities:
 * - Filter findings based on configuration
 * - Create GitHub issues for approved findings
 * - Format issue content (title, body, labels)
 * - Update finding status in database
 * - Skip security findings (handled by SecurityDisclosureManager)
 */
export class FindingProcessor {
  constructor(
    private stateManager: StateManager,
    private config: AuditConfig
  ) {}

  /**
   * Process multiple findings based on configuration
   */
  async processFindings(findings: AuditFinding[]): Promise<ProcessedFinding[]> {
    const results: ProcessedFinding[] = [];

    for (const finding of findings) {
      const result = await this.processSingleFinding(finding);
      results.push(result);
    }

    return results;
  }

  /**
   * Process a single finding
   */
  private async processSingleFinding(finding: AuditFinding): Promise<ProcessedFinding> {
    // Security findings are handled separately by SecurityDisclosureManager
    if (finding.category === "security") {
      logger.debug(
        `Skipping security finding ${finding.id} - handled by SecurityDisclosureManager`
      );
      return {
        finding,
        issueCreated: false,
      };
    }

    // Check if we should create an issue for this finding
    if (!this.shouldCreateIssue(finding)) {
      logger.debug(
        `Skipping issue creation for finding ${finding.id} - mode=${this.config.issueCreation.mode}, severity=${finding.severity}`
      );
      return {
        finding,
        issueCreated: false,
      };
    }

    // Extract project ID from audit run
    const auditRun = this.stateManager.getAuditRun(finding.auditRunId);
    if (!auditRun) {
      logger.error(`Audit run ${finding.auditRunId} not found for finding ${finding.id}`);
      return {
        finding,
        issueCreated: false,
        error: "Audit run not found",
      };
    }

    // Create GitHub issue
    try {
      const issueUrl = await this.createGitHubIssue(auditRun.projectId, finding);
      logger.success(`Created issue for finding ${finding.id}: ${issueUrl}`);

      // Update finding status
      this.stateManager.updateAuditFinding(finding.id, {
        status: "issue_created",
        issueUrl,
      });

      return {
        finding: { ...finding, status: "issue_created", issueUrl },
        issueCreated: true,
        issueUrl,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to create issue for finding ${finding.id}: ${errorMsg}`);
      return {
        finding,
        issueCreated: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Determine if an issue should be created for this finding
   */
  shouldCreateIssue(finding: AuditFinding): boolean {
    // Never create issues for security findings (handled separately)
    if (finding.category === "security") {
      return false;
    }

    // Already has an issue
    if (finding.status === "issue_created" || finding.issueUrl) {
      return false;
    }

    // Rejected findings don't get issues
    if (finding.status === "rejected") {
      return false;
    }

    const mode = this.config.issueCreation.mode;

    // Never mode - don't create any issues
    if (mode === "never") {
      return false;
    }

    // Approve mode - only create for approved findings
    if (mode === "approve") {
      return finding.status === "approved";
    }

    // Auto mode - create for specified severities
    if (mode === "auto") {
      const autoSeverities = this.config.issueCreation.autoCreateSeverities ?? [
        "critical",
        "high",
        "medium",
      ];
      return autoSeverities.includes(finding.severity);
    }

    return false;
  }

  /**
   * Create a GitHub issue for a finding
   */
  async createGitHubIssue(projectId: string, finding: AuditFinding): Promise<string> {
    const [owner, repo] = projectId.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const title = this.formatIssueTitle(finding);
    const body = this.formatIssueBody(finding);
    const labels = this.getIssueLabels(finding);

    const args = [
      "issue",
      "create",
      "--repo",
      `${owner}/${repo}`,
      "--title",
      title,
      "--body",
      body,
    ];

    if (labels.length > 0) {
      args.push("--label", labels.join(","));
    }

    return this.execGh(args);
  }

  /**
   * Format issue title
   */
  formatIssueTitle(finding: AuditFinding): string {
    return `[${finding.category}] ${finding.title}`;
  }

  /**
   * Format issue body with all finding details
   */
  formatIssueBody(finding: AuditFinding): string {
    let body = `## Description\n\n${finding.description}\n\n`;

    // Location information
    if (finding.filePath) {
      body += `## Location\n\n`;
      if (finding.lineNumber) {
        body += `\`${finding.filePath}:${finding.lineNumber}\`\n\n`;
      } else {
        body += `\`${finding.filePath}\`\n\n`;
      }
    }

    // Code snippet
    if (finding.codeSnippet) {
      body += `## Evidence\n\n\`\`\`\n${finding.codeSnippet}\n\`\`\`\n\n`;
    }

    // Impact/severity
    body += `## Impact\n\n`;
    body += `**Severity:** ${finding.severity}\n`;
    body += `**Confidence:** ${finding.confidence}\n\n`;

    // Recommendation
    body += `## Recommendation\n\n${finding.recommendation}\n\n`;

    // Additional context from metadata
    if (finding.metadata && Object.keys(finding.metadata).length > 0) {
      body += `## Additional Context\n\n`;
      for (const [key, value] of Object.entries(finding.metadata)) {
        body += `**${key}:** ${JSON.stringify(value)}\n`;
      }
      body += `\n`;
    }

    // Footer
    body += `---\n\n_This issue was automatically discovered by oss-agent_\n`;

    return body;
  }

  /**
   * Get labels for the issue
   */
  getIssueLabels(finding: AuditFinding): string[] {
    const labels = [...this.config.issueCreation.issueLabels];

    // Add category label
    labels.push(finding.category);

    // Add severity label
    labels.push(`${finding.severity}-severity`);

    return labels;
  }

  /**
   * Execute gh CLI command
   */
  private execGh(args: string[], timeoutMs = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("gh", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      // Set timeout to prevent hanging
      timeoutId = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`gh command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        if (code === 0) {
          // gh issue create returns the issue URL
          resolve(stdout.trim());
        } else {
          reject(new Error(`gh ${args.join(" ")} failed: ${stderr}`));
        }
      });

      proc.on("error", (err) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        reject(new Error(`Failed to spawn gh: ${err.message}`));
      });
    });
  }
}
