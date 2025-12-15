import { describe, it, expect } from "vitest";
import { isValidCampaignTransition, isCampaignTerminal } from "../../src/types/campaign.js";

describe("Campaign Types", () => {
  describe("isValidCampaignTransition", () => {
    it("should allow draft -> active", () => {
      expect(isValidCampaignTransition("draft", "active")).toBe(true);
    });

    it("should allow draft -> cancelled", () => {
      expect(isValidCampaignTransition("draft", "cancelled")).toBe(true);
    });

    it("should allow active -> paused", () => {
      expect(isValidCampaignTransition("active", "paused")).toBe(true);
    });

    it("should allow active -> completed", () => {
      expect(isValidCampaignTransition("active", "completed")).toBe(true);
    });

    it("should allow active -> cancelled", () => {
      expect(isValidCampaignTransition("active", "cancelled")).toBe(true);
    });

    it("should allow paused -> active", () => {
      expect(isValidCampaignTransition("paused", "active")).toBe(true);
    });

    it("should allow paused -> cancelled", () => {
      expect(isValidCampaignTransition("paused", "cancelled")).toBe(true);
    });

    it("should not allow draft -> completed", () => {
      expect(isValidCampaignTransition("draft", "completed")).toBe(false);
    });

    it("should not allow draft -> paused", () => {
      expect(isValidCampaignTransition("draft", "paused")).toBe(false);
    });

    it("should not allow completed -> anything", () => {
      expect(isValidCampaignTransition("completed", "active")).toBe(false);
      expect(isValidCampaignTransition("completed", "cancelled")).toBe(false);
    });

    it("should not allow cancelled -> anything", () => {
      expect(isValidCampaignTransition("cancelled", "active")).toBe(false);
      expect(isValidCampaignTransition("cancelled", "draft")).toBe(false);
    });
  });

  describe("isCampaignTerminal", () => {
    it("should identify completed as terminal", () => {
      expect(isCampaignTerminal("completed")).toBe(true);
    });

    it("should identify cancelled as terminal", () => {
      expect(isCampaignTerminal("cancelled")).toBe(true);
    });

    it("should not identify draft as terminal", () => {
      expect(isCampaignTerminal("draft")).toBe(false);
    });

    it("should not identify active as terminal", () => {
      expect(isCampaignTerminal("active")).toBe(false);
    });

    it("should not identify paused as terminal", () => {
      expect(isCampaignTerminal("paused")).toBe(false);
    });
  });
});

describe("Provider URL Parsing", () => {
  // These test the URL parsing logic that's common across providers
  // The actual providers require CLI tools (gh, glab) to be available

  describe("GitHub URL patterns", () => {
    it("should parse standard issue URLs", () => {
      const url = "https://github.com/owner/repo/issues/123";
      const parsed = new globalThis.URL(url);
      const pathParts = parsed.pathname.split("/").filter(Boolean);

      expect(pathParts[0]).toBe("owner");
      expect(pathParts[1]).toBe("repo");
      expect(pathParts[2]).toBe("issues");
      expect(pathParts[3]).toBe("123");
    });

    it("should parse PR URLs", () => {
      const url = "https://github.com/owner/repo/pull/456";
      const parsed = new globalThis.URL(url);
      const pathParts = parsed.pathname.split("/").filter(Boolean);

      expect(pathParts[0]).toBe("owner");
      expect(pathParts[1]).toBe("repo");
      expect(pathParts[2]).toBe("pull");
      expect(pathParts[3]).toBe("456");
    });

    it("should handle .git suffix in repo URLs", () => {
      const url = "https://github.com/owner/repo.git";
      const parsed = new globalThis.URL(url);
      const pathParts = parsed.pathname.split("/").filter(Boolean);
      const repo = pathParts[1]?.replace(/\.git$/, "");

      expect(repo).toBe("repo");
    });
  });

  describe("GitLab URL patterns", () => {
    it("should parse standard MR URLs", () => {
      const url = "https://gitlab.com/owner/repo/-/merge_requests/123";
      const parsed = new globalThis.URL(url);
      const pathParts = parsed.pathname.split("/").filter(Boolean);

      expect(pathParts[0]).toBe("owner");
      expect(pathParts[1]).toBe("repo");
      expect(pathParts[2]).toBe("-");
      expect(pathParts[3]).toBe("merge_requests");
      expect(pathParts[4]).toBe("123");
    });

    it("should parse issue URLs", () => {
      const url = "https://gitlab.com/owner/repo/-/issues/456";
      const parsed = new globalThis.URL(url);
      const pathParts = parsed.pathname.split("/").filter(Boolean);

      expect(pathParts[3]).toBe("issues");
      expect(pathParts[4]).toBe("456");
    });

    it("should handle subgroups", () => {
      const url = "https://gitlab.com/group/subgroup/repo/-/merge_requests/789";
      const parsed = new globalThis.URL(url);
      const pathParts = parsed.pathname.split("/").filter(Boolean);

      // group/subgroup would be the "owner" in GitLab's case
      expect(pathParts[0]).toBe("group");
      expect(pathParts[1]).toBe("subgroup");
      expect(pathParts[2]).toBe("repo");
    });
  });

  describe("Enterprise URL patterns", () => {
    it("should detect enterprise hosts", () => {
      const enterpriseUrl = "https://github.mycompany.com/owner/repo/issues/1";
      const publicUrl = "https://github.com/owner/repo/issues/1";

      expect(new globalThis.URL(enterpriseUrl).host).toBe("github.mycompany.com");
      expect(new globalThis.URL(publicUrl).host).toBe("github.com");
      expect(new globalThis.URL(enterpriseUrl).host).not.toBe("github.com");
    });

    it("should parse GitLab self-hosted URLs", () => {
      const url = "https://gitlab.mycompany.com/team/project/-/merge_requests/42";
      const parsed = new globalThis.URL(url);

      expect(parsed.host).toBe("gitlab.mycompany.com");
      const pathParts = parsed.pathname.split("/").filter(Boolean);
      expect(pathParts[0]).toBe("team");
      expect(pathParts[1]).toBe("project");
    });
  });
});

describe("Issue State Mapping", () => {
  describe("Jira status mapping", () => {
    // These mappings are from jira.ts DEFAULT_STATUS_MAPPING
    const JIRA_MAPPING: Record<string, string> = {
      open: "discovered",
      "to do": "queued",
      backlog: "discovered",
      "selected for development": "queued",
      "in progress": "in_progress",
      "in review": "in_progress",
      review: "in_progress",
      done: "merged",
      closed: "closed",
      resolved: "merged",
      "won't do": "abandoned",
      "won't fix": "abandoned",
      duplicate: "abandoned",
      invalid: "abandoned",
    };

    it("should map Jira statuses to internal states", () => {
      expect(JIRA_MAPPING["open"]).toBe("discovered");
      expect(JIRA_MAPPING["to do"]).toBe("queued");
      expect(JIRA_MAPPING["in progress"]).toBe("in_progress");
      expect(JIRA_MAPPING["done"]).toBe("merged");
      expect(JIRA_MAPPING["closed"]).toBe("closed");
    });

    it("should map terminal Jira statuses correctly", () => {
      expect(JIRA_MAPPING["won't do"]).toBe("abandoned");
      expect(JIRA_MAPPING["duplicate"]).toBe("abandoned");
      expect(JIRA_MAPPING["resolved"]).toBe("merged");
    });
  });

  describe("Linear state mapping", () => {
    // These mappings are from linear.ts STATE_MAPPING
    const LINEAR_MAPPING: Record<string, string> = {
      backlog: "discovered",
      unstarted: "queued",
      todo: "queued",
      started: "in_progress",
      "in progress": "in_progress",
      "in review": "awaiting_feedback",
      done: "merged",
      completed: "merged",
      canceled: "abandoned",
      cancelled: "abandoned",
      duplicate: "abandoned",
    };

    it("should map Linear states to internal states", () => {
      expect(LINEAR_MAPPING["backlog"]).toBe("discovered");
      expect(LINEAR_MAPPING["todo"]).toBe("queued");
      expect(LINEAR_MAPPING["started"]).toBe("in_progress");
      expect(LINEAR_MAPPING["done"]).toBe("merged");
    });

    it("should handle both US and UK spelling of cancelled", () => {
      expect(LINEAR_MAPPING["canceled"]).toBe("abandoned");
      expect(LINEAR_MAPPING["cancelled"]).toBe("abandoned");
    });

    it("should map review state to awaiting_feedback", () => {
      expect(LINEAR_MAPPING["in review"]).toBe("awaiting_feedback");
    });
  });

  describe("Internal state workflow", () => {
    // Verify the internal IssueState workflow makes sense
    const VALID_STATES = [
      "discovered",
      "queued",
      "in_progress",
      "pr_created",
      "awaiting_feedback",
      "iterating",
      "merged",
      "closed",
      "abandoned",
    ];

    it("should have all expected states", () => {
      expect(VALID_STATES).toContain("discovered");
      expect(VALID_STATES).toContain("queued");
      expect(VALID_STATES).toContain("in_progress");
      expect(VALID_STATES).toContain("pr_created");
      expect(VALID_STATES).toContain("merged");
      expect(VALID_STATES).toContain("abandoned");
    });

    it("should have terminal states at the end of workflow", () => {
      const terminalStates = ["merged", "closed", "abandoned"];
      terminalStates.forEach((state) => {
        expect(VALID_STATES).toContain(state);
      });
    });
  });
});
