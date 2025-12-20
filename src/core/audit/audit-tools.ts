/**
 * Custom MCP tools for audit operations
 *
 * These tools allow the AI to report findings in a structured way
 * using tool calls instead of JSON output parsing.
 */

import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-code";
import type {
  AuditFinding,
  AuditCategory,
  AuditSeverity,
  AuditConfidence,
} from "../../types/audit.js";

/**
 * Collected findings from audit tool calls
 */
export interface AuditToolResults {
  findings: AuditFinding[];
  complete: boolean;
}

/**
 * Creates MCP server with audit tools for structured finding reports
 *
 * The AI calls `report_audit_finding` for each issue it discovers,
 * and `complete_audit` when done analyzing.
 */
export function createAuditMcpServer(
  runId: string,
  category: AuditCategory,
  results: AuditToolResults
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "audit-tools",
    version: "1.0.0",
    tools: [
      tool(
        "report_audit_finding",
        `Report a ${category} issue found during the audit. Call this tool for EACH issue you discover.`,
        {
          title: z.string().describe("Brief, descriptive title of the issue"),
          severity: z
            .enum(["critical", "high", "medium", "low", "info"])
            .describe(
              "Severity level: critical (security breach/data loss), high (significant risk), medium (moderate concern), low (minor issue), info (observation)"
            ),
          confidence: z
            .enum(["high", "medium", "low"])
            .describe(
              "Your confidence in this finding: high (verified through code examination), medium (strong evidence but not verified), low (pattern suggests issue, needs validation)"
            ),
          description: z.string().describe("Detailed description of the issue and why it matters"),
          filePath: z
            .string()
            .optional()
            .describe("Relative path to the affected file, if applicable"),
          lineNumber: z
            .number()
            .optional()
            .describe("Line number where the issue occurs, if applicable"),
          codeSnippet: z.string().optional().describe("Relevant code snippet showing the issue"),
          recommendation: z.string().describe("Specific recommendation for fixing the issue"),
          cweId: z
            .string()
            .optional()
            .describe("CWE ID if this is a security issue (e.g., CWE-89)"),
          references: z.array(z.string()).optional().describe("URLs or documentation references"),
        },
        async (args) => {
          const now = new Date();
          const finding: AuditFinding = {
            id: `finding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            auditRunId: runId,
            category,
            severity: args.severity as AuditSeverity,
            confidence: args.confidence as AuditConfidence,
            title: args.title,
            description: args.description,
            recommendation: args.recommendation,
            status: "pending",
            createdAt: now,
            updatedAt: now,
          };

          // Add optional fields if provided
          if (args.filePath) {
            finding.filePath = args.filePath;
          }
          if (args.lineNumber) {
            finding.lineNumber = args.lineNumber;
          }
          if (args.codeSnippet) {
            finding.codeSnippet = args.codeSnippet;
          }
          if (args.cweId || args.references) {
            finding.metadata = {};
            if (args.cweId) {
              finding.metadata.cweId = args.cweId;
            }
            if (args.references) {
              finding.metadata.references = args.references;
            }
          }

          results.findings.push(finding);

          return {
            content: [
              {
                type: "text" as const,
                text: `Finding reported: "${args.title}" (${args.severity} severity, ${args.confidence} confidence)`,
              },
            ],
          };
        }
      ),
      tool(
        "complete_audit",
        "Call this when you have finished analyzing the repository and reported all findings. Provide a summary of what you examined.",
        {
          summary: z
            .string()
            .describe("Brief summary of what areas were examined and key observations"),
          areasExamined: z
            .array(z.string())
            .describe("List of areas/files/patterns that were examined"),
          noIssuesFound: z
            .boolean()
            .optional()
            .describe("Set to true if you found no issues worth reporting"),
        },
        async (args) => {
          results.complete = true;

          const findingCount = results.findings.length;
          let responseText = `Audit complete. ${findingCount} finding(s) reported.`;
          if (args.noIssuesFound) {
            responseText += " No significant issues were found.";
          }
          responseText += `\n\nAreas examined: ${args.areasExamined.join(", ")}\n\nSummary: ${args.summary}`;

          return {
            content: [
              {
                type: "text" as const,
                text: responseText,
              },
            ],
          };
        }
      ),
    ],
  });
}

/**
 * Get the tool names that should be allowed for auditing
 */
export function getAuditToolNames(): string[] {
  return [
    // Standard file exploration tools
    "Read",
    "Glob",
    "Grep",
    // Our custom audit tools
    "mcp__audit-tools__report_audit_finding",
    "mcp__audit-tools__complete_audit",
  ];
}
