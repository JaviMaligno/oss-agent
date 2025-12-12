import { StateManager } from "../state/state-manager.js";
import { Issue } from "../../types/issue.js";
import { logger } from "../../infra/logger.js";

/**
 * Result of pre-flight conflict detection
 */
export interface PreflightConflictResult {
  /** Whether conflicts were detected */
  hasConflicts: boolean;
  /** Issues with potential conflicts */
  conflictingIssues: Array<{
    issueUrl: string;
    predictedFiles: string[];
    overlapWith: Array<{
      issueUrl: string;
      sharedFiles: string[];
    }>;
  }>;
}

/**
 * Result of checking a single issue against in-progress work
 */
export interface ConflictCheckResult {
  /** Whether it's safe to proceed (no conflicts) */
  safe: boolean;
  /** List of conflicting issue URLs */
  conflicts: string[];
  /** Files that would conflict */
  conflictingFiles: string[];
}

/**
 * ConflictDetector - Detects potential conflicts between issues
 *
 * Provides pre-flight detection by analyzing issue descriptions to predict
 * which files might be touched, preventing conflicts before work begins.
 */
export class ConflictDetector {
  // Common file path patterns to match in issue text
  private static readonly FILE_PATTERNS = [
    // Explicit file paths
    /(?:^|\s|`)((?:src|lib|test|tests|app|packages|components|pages|api)\/[\w\-./]+\.\w+)/gim,
    // File references with extensions
    /(?:^|\s|`)([\w\-./]+\.(?:ts|tsx|js|jsx|py|rb|go|rs|java|c|cpp|h|hpp|css|scss|html|json|yaml|yml|md|txt))/gim,
    // Module/component names that might indicate files
    /(?:in|from|import|require)\s+['"]([@\w\-./]+)['"]/gi,
  ];

  // Component/module patterns
  private static readonly COMPONENT_PATTERNS = [
    // React/Vue components
    /(?:<|component\s+)\s*([\w]+)(?:\s|>|\/)/gi,
    // Class names
    /class\s+([\w]+)/gi,
    // Function names
    /(?:function|def|fn)\s+([\w]+)/gi,
  ];

  // Keywords that indicate areas of the codebase
  private static readonly AREA_KEYWORDS: Record<string, string[]> = {
    "src/auth": ["auth", "login", "logout", "session", "token", "oauth", "jwt"],
    "src/api": ["api", "endpoint", "route", "handler", "controller"],
    "src/database": ["database", "db", "query", "migration", "schema", "model"],
    "src/ui": ["ui", "component", "button", "form", "modal", "dialog"],
    "src/utils": ["util", "helper", "common", "shared"],
    "tests/": ["test", "spec", "fixture"],
    "docs/": ["docs", "documentation", "readme"],
    config: ["config", "settings", "env", "environment"],
  };

  constructor(private stateManager: StateManager) {}

  /**
   * Analyze an issue to predict which files it might touch
   */
  analyzeIssueScope(issueUrl: string, issueTitle: string, issueBody: string): string[] {
    const text = `${issueTitle}\n${issueBody}`;
    const predictedFiles = new Set<string>();

    // Extract explicit file paths
    for (const pattern of ConflictDetector.FILE_PATTERNS) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) {
          predictedFiles.add(this.normalizeFilePath(match[1]));
        }
      }
    }

    // Extract component/class names and map to potential files
    for (const pattern of ConflictDetector.COMPONENT_PATTERNS) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) {
          // Convert PascalCase to potential file paths
          const name = match[1];
          predictedFiles.add(`src/components/${name}.tsx`);
          predictedFiles.add(`src/components/${this.toKebabCase(name)}.tsx`);
        }
      }
    }

    // Detect area keywords
    const lowercaseText = text.toLowerCase();
    for (const [area, keywords] of Object.entries(ConflictDetector.AREA_KEYWORDS)) {
      for (const keyword of keywords) {
        if (lowercaseText.includes(keyword)) {
          predictedFiles.add(area);
          break;
        }
      }
    }

    const result = Array.from(predictedFiles);
    logger.debug(`Analyzed issue scope for ${issueUrl}: ${result.length} potential files/areas`);

    return result;
  }

  /**
   * Check for conflicts between multiple issues before starting work
   */
  detectPreflightConflicts(
    issues: Array<{ url: string; title: string; body: string }>
  ): PreflightConflictResult {
    const issueScopes: Array<{ url: string; files: string[] }> = [];

    // Analyze each issue
    for (const issue of issues) {
      const files = this.analyzeIssueScope(issue.url, issue.title, issue.body);
      issueScopes.push({ url: issue.url, files });
    }

    const conflictingIssues: PreflightConflictResult["conflictingIssues"] = [];

    // Find overlaps
    for (let i = 0; i < issueScopes.length; i++) {
      const issueA = issueScopes[i];
      if (!issueA) continue;

      const overlaps: Array<{ issueUrl: string; sharedFiles: string[] }> = [];

      for (let j = i + 1; j < issueScopes.length; j++) {
        const issueB = issueScopes[j];
        if (!issueB) continue;

        const sharedFiles = this.findOverlappingFiles(issueA.files, issueB.files);
        if (sharedFiles.length > 0) {
          overlaps.push({ issueUrl: issueB.url, sharedFiles });
        }
      }

      if (overlaps.length > 0) {
        conflictingIssues.push({
          issueUrl: issueA.url,
          predictedFiles: issueA.files,
          overlapWith: overlaps,
        });
      }
    }

    const hasConflicts = conflictingIssues.length > 0;
    if (hasConflicts) {
      logger.warn(
        `Pre-flight conflict detection found ${conflictingIssues.length} potential conflicts`
      );
    }

    return { hasConflicts, conflictingIssues };
  }

  /**
   * Check if a new issue conflicts with currently in-progress work
   */
  checkAgainstInProgress(issue: { url: string; title: string; body: string }): ConflictCheckResult {
    const inProgressIssues = this.stateManager.getIssuesByState("in_progress");

    if (inProgressIssues.length === 0) {
      return { safe: true, conflicts: [], conflictingFiles: [] };
    }

    const newIssueFiles = this.analyzeIssueScope(issue.url, issue.title, issue.body);
    const conflicts: string[] = [];
    const conflictingFiles = new Set<string>();

    for (const inProgress of inProgressIssues) {
      const inProgressFiles = this.analyzeIssueScope(
        inProgress.url,
        inProgress.title,
        inProgress.body
      );
      const overlap = this.findOverlappingFiles(newIssueFiles, inProgressFiles);

      if (overlap.length > 0) {
        conflicts.push(inProgress.url);
        for (const file of overlap) {
          conflictingFiles.add(file);
        }
      }
    }

    const safe = conflicts.length === 0;
    if (!safe) {
      logger.warn(
        `Issue ${issue.url} conflicts with ${conflicts.length} in-progress issue(s): ${conflicts.join(", ")}`
      );
    }

    return {
      safe,
      conflicts,
      conflictingFiles: Array.from(conflictingFiles),
    };
  }

  /**
   * Check all issues for conflicts (for batch analysis)
   */
  analyzeAllIssues(issues: Issue[]): Map<string, string[]> {
    const conflictMap = new Map<string, string[]>();

    for (let i = 0; i < issues.length; i++) {
      const issueA = issues[i];
      if (!issueA) continue;

      const filesA = this.analyzeIssueScope(issueA.url, issueA.title, issueA.body);
      const conflicts: string[] = [];

      for (let j = i + 1; j < issues.length; j++) {
        const issueB = issues[j];
        if (!issueB) continue;

        const filesB = this.analyzeIssueScope(issueB.url, issueB.title, issueB.body);
        const overlap = this.findOverlappingFiles(filesA, filesB);

        if (overlap.length > 0) {
          conflicts.push(issueB.url);
          // Also add reverse mapping
          const existingConflicts = conflictMap.get(issueB.url) ?? [];
          existingConflicts.push(issueA.url);
          conflictMap.set(issueB.url, existingConflicts);
        }
      }

      if (conflicts.length > 0) {
        const existing = conflictMap.get(issueA.url) ?? [];
        conflictMap.set(issueA.url, [...existing, ...conflicts]);
      }
    }

    return conflictMap;
  }

  /**
   * Find overlapping files/areas between two file lists
   */
  private findOverlappingFiles(filesA: string[], filesB: string[]): string[] {
    const overlap: string[] = [];

    for (const fileA of filesA) {
      for (const fileB of filesB) {
        if (this.filesOverlap(fileA, fileB)) {
          overlap.push(fileA);
          break;
        }
      }
    }

    return overlap;
  }

  /**
   * Check if two file paths/areas overlap
   */
  private filesOverlap(fileA: string, fileB: string): boolean {
    const normalA = this.normalizeFilePath(fileA);
    const normalB = this.normalizeFilePath(fileB);

    // Exact match
    if (normalA === normalB) {
      return true;
    }

    // One is a prefix of the other (directory overlap)
    if (normalA.startsWith(normalB + "/") || normalB.startsWith(normalA + "/")) {
      return true;
    }

    // Same directory
    const dirA = normalA.substring(0, normalA.lastIndexOf("/"));
    const dirB = normalB.substring(0, normalB.lastIndexOf("/"));
    if (dirA && dirB && dirA === dirB) {
      return true;
    }

    return false;
  }

  /**
   * Normalize a file path for comparison
   */
  private normalizeFilePath(path: string): string {
    return path
      .toLowerCase()
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "");
  }

  /**
   * Convert PascalCase to kebab-case
   */
  private toKebabCase(str: string): string {
    return str
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
      .toLowerCase();
  }
}
