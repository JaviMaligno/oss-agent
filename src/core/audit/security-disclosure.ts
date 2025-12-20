import { spawn } from "node:child_process";
import { logger } from "../../infra/logger.js";
import { AuditFinding, AuditConfig } from "../../types/audit.js";

export type DisclosureMode = "advisory" | "private-issue" | "public-issue";

export interface DisclosureResult {
  finding: AuditFinding;
  mode: DisclosureMode;
  success: boolean;
  url?: string;
  error?: string;
}

/**
 * SecurityDisclosureManager - Handles responsible disclosure of security findings
 *
 * Responsibilities:
 * - Determine appropriate disclosure mode based on severity
 * - Create GitHub security advisories for critical/high vulnerabilities
 * - Create private or public issues for lower severity findings
 * - Format security-focused descriptions (no exploit details)
 * - Map severity levels to GitHub advisory format
 */
export class SecurityDisclosureManager {
  constructor(private config: AuditConfig) {}

  /**
   * Disclose a security finding using the appropriate method
   */
  async disclose(projectId: string, finding: AuditFinding): Promise<DisclosureResult> {
    const mode = this.getDisclosureMode(finding);

    logger.info(
      `Disclosing security finding ${finding.id} using mode: ${mode} (severity: ${finding.severity})`
    );

    try {
      let url: string;

      switch (mode) {
        case "advisory":
          url = await this.createGitHubAdvisory(projectId, finding);
          break;
        case "private-issue":
          url = await this.createPrivateIssue(projectId, finding);
          break;
        case "public-issue":
          url = await this.createPublicIssue(projectId, finding);
          break;
      }

      logger.success(`Security finding disclosed: ${url}`);

      return {
        finding,
        mode,
        success: true,
        url,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to disclose security finding ${finding.id}: ${errorMsg}`);

      return {
        finding,
        mode,
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Determine the appropriate disclosure mode based on severity and configuration
   */
  private getDisclosureMode(finding: AuditFinding): DisclosureMode {
    // Check if severity requires advisory
    if (this.config.security.advisorySeverities.includes(finding.severity)) {
      return "advisory";
    }

    // Otherwise, use configured disclosure mode
    return this.config.security.disclosureMode;
  }

  /**
   * Create a GitHub security advisory
   *
   * Uses GitHub's security advisory API to create a draft advisory.
   * This keeps the vulnerability private until the maintainers are ready to publish.
   */
  async createGitHubAdvisory(projectId: string, finding: AuditFinding): Promise<string> {
    const [owner, repo] = projectId.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const summary = finding.title;
    const description = this.formatAdvisoryDescription(finding);
    const severity = this.mapSeverityToGitHub(finding.severity);
    const cweId = this.getCWEId(finding);

    const args = [
      "api",
      `repos/${owner}/${repo}/security-advisories`,
      "-X",
      "POST",
      "-f",
      `summary=${summary}`,
      "-f",
      `description=${description}`,
      "-f",
      `severity=${severity}`,
    ];

    // Add CWE ID if available
    if (cweId) {
      args.push("-f", `cwe_ids[]=${cweId}`);
    }

    const result = await this.execGh(args);

    // Parse response to get advisory URL
    const data = JSON.parse(result) as { html_url: string };
    return data.html_url;
  }

  /**
   * Create a private issue for security disclosure
   *
   * Creates a regular issue with labels indicating it's a security concern.
   * Note: GitHub doesn't support truly "private" issues in public repos,
   * so this is mainly for documentation purposes.
   */
  async createPrivateIssue(projectId: string, finding: AuditFinding): Promise<string> {
    const [owner, repo] = projectId.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const title = `[SECURITY] ${finding.title}`;
    const body = this.formatSecurityIssueBody(finding, true);
    const labels = ["security", `${finding.severity}-severity`, "audit-finding"];

    const args = [
      "issue",
      "create",
      "--repo",
      `${owner}/${repo}`,
      "--title",
      title,
      "--body",
      body,
      "--label",
      labels.join(","),
    ];

    return this.execGh(args);
  }

  /**
   * Create a public issue for security disclosure
   *
   * For lower-severity security findings that don't require private disclosure.
   */
  async createPublicIssue(projectId: string, finding: AuditFinding): Promise<string> {
    const [owner, repo] = projectId.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const title = `[security] ${finding.title}`;
    const body = this.formatSecurityIssueBody(finding, false);
    const labels = ["security", `${finding.severity}-severity`, "audit-finding"];

    const args = [
      "issue",
      "create",
      "--repo",
      `${owner}/${repo}`,
      "--title",
      title,
      "--body",
      body,
      "--label",
      labels.join(","),
    ];

    return this.execGh(args);
  }

  /**
   * Format security advisory description
   *
   * IMPORTANT: Does NOT include exploit code or detailed attack vectors.
   * Focuses on vulnerability type, impact, and remediation.
   */
  formatAdvisoryDescription(finding: AuditFinding): string {
    let description = `## Summary\n\n${finding.description}\n\n`;

    // Impact
    description += `## Impact\n\n`;
    description += `This vulnerability has been classified as **${finding.severity}** severity.\n\n`;

    // Location (without code snippets)
    if (finding.filePath) {
      description += `## Affected Component\n\n`;
      description += `The vulnerability is located in \`${finding.filePath}\``;
      if (finding.lineNumber) {
        description += ` (around line ${finding.lineNumber})`;
      }
      description += `.\n\n`;
    }

    // Remediation
    description += `## Remediation\n\n${finding.recommendation}\n\n`;

    // Additional context (sanitized)
    if (finding.metadata) {
      const safeMetadata: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(finding.metadata)) {
        // Skip potentially sensitive keys
        if (!key.toLowerCase().includes("exploit") && !key.toLowerCase().includes("payload")) {
          safeMetadata[key] = value;
        }
      }

      if (Object.keys(safeMetadata).length > 0) {
        description += `## Additional Information\n\n`;
        for (const [key, value] of Object.entries(safeMetadata)) {
          description += `**${key}:** ${JSON.stringify(value)}\n`;
        }
        description += `\n`;
      }
    }

    description += `---\n\n_This security advisory was automatically generated by oss-agent_\n`;

    return description;
  }

  /**
   * Format security issue body
   */
  private formatSecurityIssueBody(finding: AuditFinding, isPrivate: boolean): string {
    let body = "";

    if (isPrivate) {
      body += `> **Note:** This is a security-related issue. Please handle with care.\n\n`;
    }

    body += `## Description\n\n${finding.description}\n\n`;

    // Location
    if (finding.filePath) {
      body += `## Location\n\n`;
      if (finding.lineNumber) {
        body += `\`${finding.filePath}:${finding.lineNumber}\`\n\n`;
      } else {
        body += `\`${finding.filePath}\`\n\n`;
      }
    }

    // Impact
    body += `## Impact\n\n`;
    body += `**Severity:** ${finding.severity}\n`;
    body += `**Confidence:** ${finding.confidence}\n\n`;

    // Recommendation (no exploit details)
    body += `## Recommendation\n\n${finding.recommendation}\n\n`;

    body += `---\n\n_This security issue was automatically discovered by oss-agent_\n`;

    return body;
  }

  /**
   * Map our severity levels to GitHub advisory severity
   */
  mapSeverityToGitHub(severity: string): string {
    switch (severity) {
      case "critical":
        return "critical";
      case "high":
        return "high";
      case "medium":
        return "moderate";
      case "low":
        return "low";
      default:
        return "low";
    }
  }

  /**
   * Extract CWE ID from finding metadata
   */
  getCWEId(finding: AuditFinding): string | undefined {
    if (!finding.metadata) {
      return undefined;
    }

    // Check for CWE ID in metadata
    const cwe = finding.metadata["cwe"] ?? finding.metadata["cweId"] ?? finding.metadata["CWE"];
    if (typeof cwe === "string") {
      // Extract numeric CWE ID (e.g., "CWE-79" -> "79")
      const match = cwe.match(/CWE[-_]?(\d+)/i);
      return match ? match[1] : undefined;
    }

    if (typeof cwe === "number") {
      return String(cwe);
    }

    return undefined;
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
