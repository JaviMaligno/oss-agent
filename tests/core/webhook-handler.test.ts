import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { WebhookHandler } from "../../src/core/engine/webhook-handler.js";

// Mock child_process spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

describe("WebhookHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("delete branch on merge", () => {
    it("should delete branch when PR is merged and option is enabled", async () => {
      const mockProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === "close") {
            // Simulate successful deletion
            setTimeout(() => callback(0), 10);
          }
        }),
      };
      mockSpawn.mockReturnValue(mockProcess);

      const handler = new WebhookHandler({
        port: 3000,
        deleteBranchOnMerge: true,
      });

      // Simulate a merged PR event
      const payload = {
        action: "closed",
        pull_request: {
          merged: true,
          html_url: "https://github.com/owner/repo/pull/123",
          head: { ref: "feature-branch" },
        },
        repository: {
          full_name: "owner/repo",
        },
      };

      // Access private method for testing
      const handleEvent = (
        handler as unknown as {
          handleEvent: (type: string, payload: Record<string, unknown>) => boolean;
        }
      ).handleEvent.bind(handler);
      const result = handleEvent("pull_request", payload);

      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        "gh",
        ["api", "-X", "DELETE", "/repos/owner/repo/git/refs/heads/feature-branch"],
        expect.objectContaining({
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        })
      );
    });

    it("should NOT delete branch when option is disabled", async () => {
      const handler = new WebhookHandler({
        port: 3000,
        deleteBranchOnMerge: false,
      });

      const payload = {
        action: "closed",
        pull_request: {
          merged: true,
          html_url: "https://github.com/owner/repo/pull/123",
          head: { ref: "feature-branch" },
        },
        repository: {
          full_name: "owner/repo",
        },
      };

      const handleEvent = (
        handler as unknown as {
          handleEvent: (type: string, payload: Record<string, unknown>) => boolean;
        }
      ).handleEvent.bind(handler);
      const result = handleEvent("pull_request", payload);

      expect(result).toBe(true);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("should NOT delete branch when PR is closed but not merged", async () => {
      const handler = new WebhookHandler({
        port: 3000,
        deleteBranchOnMerge: true,
      });

      const payload = {
        action: "closed",
        pull_request: {
          merged: false, // Not merged, just closed
          html_url: "https://github.com/owner/repo/pull/123",
          head: { ref: "feature-branch" },
        },
        repository: {
          full_name: "owner/repo",
        },
      };

      const handleEvent = (
        handler as unknown as {
          handleEvent: (type: string, payload: Record<string, unknown>) => boolean;
        }
      ).handleEvent.bind(handler);
      const result = handleEvent("pull_request", payload);

      expect(result).toBe(false);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("should NOT delete branch when action is not 'closed'", async () => {
      const handler = new WebhookHandler({
        port: 3000,
        deleteBranchOnMerge: true,
      });

      const payload = {
        action: "opened",
        pull_request: {
          merged: false,
          html_url: "https://github.com/owner/repo/pull/123",
          head: { ref: "feature-branch" },
        },
        repository: {
          full_name: "owner/repo",
        },
      };

      const handleEvent = (
        handler as unknown as {
          handleEvent: (type: string, payload: Record<string, unknown>) => boolean;
        }
      ).handleEvent.bind(handler);
      const result = handleEvent("pull_request", payload);

      expect(result).toBe(false);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("should respect allowedRepos filter", async () => {
      const handler = new WebhookHandler({
        port: 3000,
        deleteBranchOnMerge: true,
        allowedRepos: ["allowed/repo"],
      });

      const payload = {
        action: "closed",
        pull_request: {
          merged: true,
          html_url: "https://github.com/other/repo/pull/123",
          head: { ref: "feature-branch" },
        },
        repository: {
          full_name: "other/repo", // Not in allowedRepos
        },
      };

      const handleEvent = (
        handler as unknown as {
          handleEvent: (type: string, payload: Record<string, unknown>) => boolean;
        }
      ).handleEvent.bind(handler);
      const result = handleEvent("pull_request", payload);

      expect(result).toBe(false);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("should delete branch when repo is in allowedRepos", async () => {
      const mockProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockProcess);

      const handler = new WebhookHandler({
        port: 3000,
        deleteBranchOnMerge: true,
        allowedRepos: ["allowed/repo"],
      });

      const payload = {
        action: "closed",
        pull_request: {
          merged: true,
          html_url: "https://github.com/allowed/repo/pull/123",
          head: { ref: "feature-branch" },
        },
        repository: {
          full_name: "allowed/repo",
        },
      };

      const handleEvent = (
        handler as unknown as {
          handleEvent: (type: string, payload: Record<string, unknown>) => boolean;
        }
      ).handleEvent.bind(handler);
      const result = handleEvent("pull_request", payload);

      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        "gh",
        ["api", "-X", "DELETE", "/repos/allowed/repo/git/refs/heads/feature-branch"],
        expect.any(Object)
      );
    });
  });

  describe("auto-iterate on feedback", () => {
    it("should trigger iterate on review event when autoIterate is enabled", async () => {
      const mockProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        unref: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockProcess);

      const handler = new WebhookHandler({
        port: 3000,
        autoIterate: true,
      });

      const payload = {
        action: "submitted",
        pull_request: {
          html_url: "https://github.com/owner/repo/pull/123",
        },
        review: {
          state: "changes_requested",
          user: { login: "reviewer" },
        },
        repository: {
          full_name: "owner/repo",
        },
      };

      const handleEvent = (
        handler as unknown as {
          handleEvent: (type: string, payload: Record<string, unknown>) => boolean;
        }
      ).handleEvent.bind(handler);
      const result = handleEvent("pull_request_review", payload);

      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        "node",
        ["dist/cli/index.js", "iterate", "https://github.com/owner/repo/pull/123", "--verbose"],
        expect.any(Object)
      );
    });

    it("should NOT trigger iterate when autoIterate is disabled", async () => {
      const handler = new WebhookHandler({
        port: 3000,
        autoIterate: false,
      });

      const payload = {
        action: "submitted",
        pull_request: {
          html_url: "https://github.com/owner/repo/pull/123",
        },
        review: {
          state: "changes_requested",
          user: { login: "reviewer" },
        },
        repository: {
          full_name: "owner/repo",
        },
      };

      const handleEvent = (
        handler as unknown as {
          handleEvent: (type: string, payload: Record<string, unknown>) => boolean;
        }
      ).handleEvent.bind(handler);
      const result = handleEvent("pull_request_review", payload);

      expect(result).toBe(true);
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });
});
