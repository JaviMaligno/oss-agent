/**
 * Test helpers for CLI commands
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../../src/core/state/state-manager.js";
import type {
  AIProvider,
  QueryResult,
  ProviderCapabilities,
  ProviderUsage,
  QueryOptions,
} from "../../src/core/ai/types.js";

/**
 * Create a temporary test environment with StateManager
 */
export function createTestEnvironment(): {
  tempDir: string;
  stateManager: StateManager;
  cleanup: () => void;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "oss-agent-cli-test-"));
  const stateManager = new StateManager(tempDir);

  return {
    tempDir,
    stateManager,
    cleanup: () => {
      stateManager.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/**
 * Mock AI Provider for testing
 */
export class MockAIProvider implements AIProvider {
  readonly name = "mock";

  readonly capabilities: ProviderCapabilities = {
    costTracking: true,
    sessionResume: false,
    streaming: false,
    budgetLimits: true,
  };

  private _usage: ProviderUsage = {
    totalQueries: 0,
    totalCostUsd: 0,
    totalTurns: 0,
    queriesToday: 0,
    costTodayUsd: 0,
  };

  private _mockResult: QueryResult = {
    success: true,
    output: "Mock response",
    turns: 1,
    durationMs: 100,
  };

  private _isAvailable = true;

  /**
   * Set the mock result to return from query()
   */
  setMockResult(result: Partial<QueryResult>): void {
    this._mockResult = { ...this._mockResult, ...result };
  }

  /**
   * Set whether the provider is available
   */
  setAvailable(available: boolean): void {
    this._isAvailable = available;
  }

  async isAvailable(): Promise<boolean> {
    return this._isAvailable;
  }

  async query(_prompt: string, _options: QueryOptions): Promise<QueryResult> {
    this._usage.totalQueries++;
    this._usage.queriesToday++;
    this._usage.totalTurns += this._mockResult.turns;
    if (this._mockResult.costUsd) {
      this._usage.totalCostUsd += this._mockResult.costUsd;
      this._usage.costTodayUsd += this._mockResult.costUsd;
    }
    return this._mockResult;
  }

  getUsage(): ProviderUsage {
    return { ...this._usage };
  }

  /**
   * Reset usage statistics
   */
  resetUsage(): void {
    this._usage = {
      totalQueries: 0,
      totalCostUsd: 0,
      totalTurns: 0,
      queriesToday: 0,
      costTodayUsd: 0,
    };
  }
}

/**
 * Capture console output during test execution
 */
export function captureConsole(): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  };

  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  };

  return {
    stdout,
    stderr,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

/**
 * Parse a GitHub issue URL into owner/repo/number
 */
export function parseIssueUrl(url: string): {
  owner: string;
  repo: string;
  issueNumber: number;
} | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!match) {
    return null;
  }
  return {
    owner: match[1]!,
    repo: match[2]!,
    issueNumber: parseInt(match[3]!, 10),
  };
}

/**
 * Create a mock issue for testing
 */
export function createMockIssue(
  overrides: Partial<{
    id: string;
    url: string;
    number: number;
    title: string;
    body: string;
    labels: string[];
    state: string;
    author: string;
    projectId: string;
  }> = {}
): {
  id: string;
  url: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  author: string;
  assignee: undefined;
  createdAt: Date;
  updatedAt: Date;
  projectId: string;
  hasLinkedPR: boolean;
  linkedPRUrl: undefined;
} {
  const now = new Date();
  return {
    id: overrides.id ?? "test-owner/test-repo#1",
    url: overrides.url ?? "https://github.com/test-owner/test-repo/issues/1",
    number: overrides.number ?? 1,
    title: overrides.title ?? "Test Issue",
    body: overrides.body ?? "This is a test issue body",
    labels: overrides.labels ?? ["bug"],
    state: overrides.state ?? "discovered",
    author: overrides.author ?? "test-user",
    assignee: undefined,
    createdAt: now,
    updatedAt: now,
    projectId: overrides.projectId ?? "test-owner/test-repo",
    hasLinkedPR: false,
    linkedPRUrl: undefined,
  };
}

/**
 * Create a mock session for testing
 */
export function createMockSession(
  overrides: Partial<{
    issueId: string;
    issueUrl: string;
    status: string;
    provider: string;
    model: string;
    startedAt: Date;
    turnCount: number;
    costUsd: number;
    prUrl: string | null;
    workingDirectory: string;
    canResume: boolean;
    error: string | null;
  }> = {}
): {
  issueId: string;
  issueUrl: string;
  status: string;
  provider: string;
  model: string;
  startedAt: Date;
  lastActivityAt: Date;
  completedAt: null;
  turnCount: number;
  costUsd: number;
  prUrl: string | null;
  workingDirectory: string;
  canResume: boolean;
  error: string | null;
} {
  const now = overrides.startedAt ?? new Date();
  return {
    issueId: overrides.issueId ?? "test-owner/test-repo#1",
    issueUrl: overrides.issueUrl ?? "https://github.com/test-owner/test-repo/issues/1",
    status: overrides.status ?? "active",
    provider: overrides.provider ?? "claude-cli",
    model: overrides.model ?? "claude-sonnet-4-20250514",
    startedAt: now,
    lastActivityAt: now,
    completedAt: null,
    turnCount: overrides.turnCount ?? 0,
    costUsd: overrides.costUsd ?? 0,
    prUrl: overrides.prUrl ?? null,
    workingDirectory: overrides.workingDirectory ?? "/tmp/test-worktree",
    canResume: overrides.canResume ?? true,
    error: overrides.error ?? null,
  };
}
