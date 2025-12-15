/**
 * Tests for MCP Server
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MCPServer, createMCPServer } from "../../src/mcp/server.js";
import { createToolRegistry } from "../../src/mcp/tools/index.js";
import { createResourceRegistry } from "../../src/mcp/resources/index.js";
import { StateManager } from "../../src/core/state/state-manager.js";
import type { Config } from "../../src/types/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("MCP Server", () => {
  let tempDir: string;
  let stateManager: StateManager;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mcp-server-test-"));
    stateManager = new StateManager(tempDir);

    config = {
      dataDir: tempDir,
      ai: {
        executionMode: "cli",
        maxSessionDuration: 3600,
        maxRetries: 3,
        retryDelayMs: 1000,
        model: "claude-sonnet-4-20250514",
        maxTurns: 100,
        outputFormat: "text",
        mcpServers: {},
        allowedTools: [],
        disallowedTools: [],
        customSystemPrompt: undefined,
        customInstructions: undefined,
        continueConversation: false,
        resume: undefined,
        sdk: {
          apiKey: undefined,
        },
        cli: {
          binaryPath: "claude",
        },
      },
      git: {
        defaultBranch: "main",
        branchPrefix: "oss-agent/",
        commitPrefix: "fix: ",
        worktreeDir: join(tempDir, "worktrees"),
        cleanupAfterMerge: true,
        signCommits: false,
        pushRetries: 3,
      },
      github: {
        defaultLabels: ["oss-agent"],
        prTemplate: undefined,
        requireApprovalBeforeMerge: true,
        autoMergeEnabled: false,
        ciCheckTimeout: 600,
      },
      budget: {
        dailyLimitUsd: 10,
        monthlyLimitUsd: 100,
        perIssueLimitUsd: 5,
        warningThresholdPercent: 80,
      },
      oss: {
        qualityGates: {
          minTestCoverage: 0,
          requireLinting: false,
          requireTypeCheck: false,
          maxPrsPerDay: 10,
        },
        issueSelection: {
          preferredLabels: ["good first issue"],
          excludedLabels: ["wontfix"],
          maxComplexity: "medium",
          minStars: 100,
          maxOpenIssues: 500,
        },
        feedback: {
          maxIterations: 3,
          iterationDelayMs: 300000,
          autoPushOnIteration: true,
        },
      },
      parallel: {
        maxConcurrentAgents: 3,
        queueStrategy: "round-robin",
        conflictResolution: "wait",
        isolationStrategy: "worktree",
      },
      hardening: {
        enabled: true,
        circuitBreaker: {
          failureThreshold: 5,
          successThreshold: 2,
          openDurationMs: 60000,
        },
        watchdog: {
          enabled: true,
          timeoutMs: 300000,
          heartbeatIntervalMs: 30000,
        },
        rateLimiting: {
          enabled: true,
          maxRequestsPerMinute: 60,
          maxConcurrentOps: 3,
        },
      },
    };
  });

  afterEach(() => {
    stateManager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createMCPServer", () => {
    it("creates a server instance", () => {
      const server = createMCPServer({ config, stateManager });
      expect(server).toBeInstanceOf(MCPServer);
    });
  });

  describe("MCPServer", () => {
    it("can be instantiated with options", () => {
      const server = new MCPServer({ config, stateManager });
      expect(server).toBeDefined();
    });

    it("returns the underlying MCP server", () => {
      const server = new MCPServer({ config, stateManager });
      const underlyingServer = server.getServer();
      expect(underlyingServer).toBeDefined();
    });

    it("can close gracefully", async () => {
      const server = new MCPServer({ config, stateManager });
      // Should not throw
      await expect(server.close()).resolves.toBeUndefined();
    });
  });

  describe("Tool Registry", () => {
    it("creates a registry with all tool groups", () => {
      const registry = createToolRegistry({ config, stateManager });
      const tools = registry.listTools();

      // Should have workflow, discovery, queue, autonomous, monitoring, and management tools
      expect(tools.length).toBeGreaterThan(10);

      // Check for key tools from each category
      const toolNames = tools.map((t) => t.name);

      // Workflow tools
      expect(toolNames).toContain("work_on_issue");
      expect(toolNames).toContain("iterate_on_feedback");

      // Queue tools
      expect(toolNames).toContain("queue_list");
      expect(toolNames).toContain("queue_add");

      // Monitoring tools
      expect(toolNames).toContain("get_status");
      expect(toolNames).toContain("get_pr_status");

      // Management tools
      expect(toolNames).toContain("get_config");
      expect(toolNames).toContain("cleanup_worktrees");
    });

    it("returns handler for registered tool", () => {
      const registry = createToolRegistry({ config, stateManager });

      const handler = registry.getHandler("queue_list");
      expect(handler).toBeDefined();
      expect(typeof handler).toBe("function");
    });

    it("returns undefined for unknown tool", () => {
      const registry = createToolRegistry({ config, stateManager });

      const handler = registry.getHandler("nonexistent_tool");
      expect(handler).toBeUndefined();
    });

    it("can disable hardening", () => {
      const registry = createToolRegistry({
        config,
        stateManager,
        hardeningEnabled: false,
      });

      // Should still create tools, just without hardening
      const tools = registry.listTools();
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  describe("Resource Registry", () => {
    it("creates a registry with all resources", () => {
      const registry = createResourceRegistry({ config, stateManager });
      const resources = registry.listResources();

      // Should have config, state, queue resources
      expect(resources.length).toBeGreaterThan(0);

      const resourceUris = resources.map((r) => r.uri);

      // Check for key resources
      expect(resourceUris).toContain("config://current");
      expect(resourceUris).toContain("state://issues");
      expect(resourceUris).toContain("queue://current");
    });

    it("can read config resource", async () => {
      const registry = createResourceRegistry({ config, stateManager });

      const content = await registry.readResource("config://current");
      expect(content).toBeDefined();
      expect(content.uri).toBe("config://current");
    });

    it("can read queue resource", async () => {
      const registry = createResourceRegistry({ config, stateManager });

      const content = await registry.readResource("queue://current");
      expect(content).toBeDefined();
      expect(content.uri).toBe("queue://current");
    });
  });
});
