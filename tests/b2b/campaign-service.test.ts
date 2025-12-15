import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CampaignService } from "../../src/b2b/campaigns/campaign-service.js";
import { StateManager } from "../../src/core/state/state-manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("CampaignService", () => {
  let campaignService: CampaignService;
  let stateManager: StateManager;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "oss-agent-campaign-test-"));
    stateManager = new StateManager(tempDir);
    // Access the db through the private field
    campaignService = new CampaignService(stateManager["db"]);
  });

  afterEach(() => {
    stateManager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Campaign CRUD", () => {
    it("should create a campaign with required fields", () => {
      const campaign = campaignService.createCampaign({
        name: "Test Campaign",
        sourceType: "manual",
      });

      expect(campaign.id).toBeDefined();
      expect(campaign.name).toBe("Test Campaign");
      expect(campaign.status).toBe("draft");
      expect(campaign.sourceType).toBe("manual");
      expect(campaign.totalIssues).toBe(0);
      expect(campaign.budgetSpentUsd).toBe(0);
    });

    it("should create a campaign with all optional fields", () => {
      const campaign = campaignService.createCampaign({
        name: "Full Campaign",
        description: "A test campaign",
        sourceType: "jira_jql",
        sourceConfig: { jql: "project = TEST" },
        budgetLimitUsd: 100,
        tags: ["test", "jira"],
      });

      expect(campaign.description).toBe("A test campaign");
      expect(campaign.sourceConfig).toEqual({ jql: "project = TEST" });
      expect(campaign.budgetLimitUsd).toBe(100);
      expect(campaign.tags).toEqual(["test", "jira"]);
    });

    it("should retrieve a campaign by ID", () => {
      const created = campaignService.createCampaign({
        name: "Retrieve Test",
        sourceType: "manual",
      });

      const retrieved = campaignService.getCampaign(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.name).toBe("Retrieve Test");
    });

    it("should return null for non-existent campaign", () => {
      const campaign = campaignService.getCampaign("non-existent-id");
      expect(campaign).toBeNull();
    });

    it("should update campaign fields", () => {
      const campaign = campaignService.createCampaign({
        name: "Original Name",
        sourceType: "manual",
      });

      campaignService.updateCampaign(campaign.id, {
        name: "Updated Name",
        description: "New description",
        budgetLimitUsd: 50,
      });

      const updated = campaignService.getCampaign(campaign.id);
      expect(updated?.name).toBe("Updated Name");
      expect(updated?.description).toBe("New description");
      expect(updated?.budgetLimitUsd).toBe(50);
    });

    it("should throw when updating non-existent campaign", () => {
      expect(() => {
        campaignService.updateCampaign("non-existent", { name: "New" });
      }).toThrow("Campaign not found");
    });

    it("should delete a campaign", () => {
      const campaign = campaignService.createCampaign({
        name: "To Delete",
        sourceType: "manual",
      });

      campaignService.deleteCampaign(campaign.id);

      const deleted = campaignService.getCampaign(campaign.id);
      expect(deleted).toBeNull();
    });

    it("should not delete active campaign", () => {
      const campaign = campaignService.createCampaign({
        name: "Active Campaign",
        sourceType: "manual",
      });

      campaignService.startCampaign(campaign.id);

      expect(() => {
        campaignService.deleteCampaign(campaign.id);
      }).toThrow("Cannot delete active campaign");
    });
  });

  describe("Campaign Listing and Filtering", () => {
    beforeEach(() => {
      campaignService.createCampaign({
        name: "Campaign 1",
        sourceType: "manual",
        tags: ["tag1"],
      });
      campaignService.createCampaign({
        name: "Campaign 2",
        sourceType: "jira_jql",
        description: "Jira campaign",
        tags: ["tag2"],
      });
      const c3 = campaignService.createCampaign({
        name: "Campaign 3",
        sourceType: "linear_filter",
      });
      campaignService.startCampaign(c3.id);
    });

    it("should list all campaigns", () => {
      const campaigns = campaignService.listCampaigns();
      expect(campaigns).toHaveLength(3);
    });

    it("should filter by status", () => {
      const drafts = campaignService.listCampaigns({ status: "draft" });
      expect(drafts).toHaveLength(2);

      const active = campaignService.listCampaigns({ status: "active" });
      expect(active).toHaveLength(1);
    });

    it("should filter by source type", () => {
      const jira = campaignService.listCampaigns({ sourceType: "jira_jql" });
      expect(jira).toHaveLength(1);
      expect(jira[0]?.name).toBe("Campaign 2");
    });

    it("should filter by search term", () => {
      const results = campaignService.listCampaigns({ search: "Jira" });
      expect(results).toHaveLength(1);
      expect(results[0]?.description).toBe("Jira campaign");
    });

    it("should filter by tags", () => {
      const results = campaignService.listCampaigns({ tags: ["tag1"] });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("Campaign 1");
    });
  });

  describe("Campaign Status Transitions", () => {
    it("should start a draft campaign", () => {
      const campaign = campaignService.createCampaign({
        name: "To Start",
        sourceType: "manual",
      });

      campaignService.startCampaign(campaign.id);

      const updated = campaignService.getCampaign(campaign.id);
      expect(updated?.status).toBe("active");
      expect(updated?.startedAt).toBeDefined();
    });

    it("should pause an active campaign", () => {
      const campaign = campaignService.createCampaign({
        name: "To Pause",
        sourceType: "manual",
      });

      campaignService.startCampaign(campaign.id);
      campaignService.pauseCampaign(campaign.id, "user", "Need to review");

      const updated = campaignService.getCampaign(campaign.id);
      expect(updated?.status).toBe("paused");
    });

    it("should resume a paused campaign", () => {
      const campaign = campaignService.createCampaign({
        name: "To Resume",
        sourceType: "manual",
      });

      campaignService.startCampaign(campaign.id);
      campaignService.pauseCampaign(campaign.id);
      campaignService.resumeCampaign(campaign.id);

      const updated = campaignService.getCampaign(campaign.id);
      expect(updated?.status).toBe("active");
    });

    it("should complete an active campaign", () => {
      const campaign = campaignService.createCampaign({
        name: "To Complete",
        sourceType: "manual",
      });

      campaignService.startCampaign(campaign.id);
      campaignService.completeCampaign(campaign.id);

      const updated = campaignService.getCampaign(campaign.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.completedAt).toBeDefined();
    });

    it("should cancel a campaign", () => {
      const campaign = campaignService.createCampaign({
        name: "To Cancel",
        sourceType: "manual",
      });

      campaignService.startCampaign(campaign.id);
      campaignService.cancelCampaign(campaign.id, "user", "Budget concerns");

      const updated = campaignService.getCampaign(campaign.id);
      expect(updated?.status).toBe("cancelled");
    });

    it("should record transitions", () => {
      const campaign = campaignService.createCampaign({
        name: "Transition Test",
        sourceType: "manual",
      });

      campaignService.startCampaign(campaign.id, "admin");
      campaignService.pauseCampaign(campaign.id, "user", "Review needed");

      // Transitions are ordered by transitioned_at DESC (most recent first)
      const transitions = campaignService.getTransitions(campaign.id);
      expect(transitions).toHaveLength(2);
      // Most recent: active -> paused
      expect(transitions[0]?.fromStatus).toBe("active");
      expect(transitions[0]?.toStatus).toBe("paused");
      expect(transitions[0]?.reason).toBe("Review needed");
      // First: draft -> active
      expect(transitions[1]?.fromStatus).toBe("draft");
      expect(transitions[1]?.toStatus).toBe("active");
    });

    it("should reject invalid transitions", () => {
      const campaign = campaignService.createCampaign({
        name: "Invalid Transition",
        sourceType: "manual",
      });

      // Cannot complete a draft campaign
      expect(() => {
        campaignService.completeCampaign(campaign.id);
      }).toThrow("Invalid campaign transition");

      // Cannot pause a draft campaign
      expect(() => {
        campaignService.pauseCampaign(campaign.id);
      }).toThrow("Invalid campaign transition");
    });

    it("should not allow updates to terminal campaigns", () => {
      const campaign = campaignService.createCampaign({
        name: "Terminal",
        sourceType: "manual",
      });

      campaignService.startCampaign(campaign.id);
      campaignService.completeCampaign(campaign.id);

      expect(() => {
        campaignService.updateCampaign(campaign.id, { name: "New Name" });
      }).toThrow("Cannot update terminal campaign");
    });
  });

  describe("Campaign Issue Management", () => {
    let campaign: ReturnType<typeof campaignService.createCampaign>;

    beforeEach(() => {
      campaign = campaignService.createCampaign({
        name: "Issue Test Campaign",
        sourceType: "manual",
      });
    });

    it("should add issues to a campaign", () => {
      const added = campaignService.addIssues(campaign.id, [
        { url: "https://github.com/owner/repo/issues/1" },
        { url: "https://github.com/owner/repo/issues/2", priority: 1 },
      ]);

      expect(added).toBe(2);

      const updated = campaignService.getCampaign(campaign.id);
      expect(updated?.totalIssues).toBe(2);
    });

    it("should not add duplicate issues", () => {
      campaignService.addIssues(campaign.id, [{ url: "https://github.com/owner/repo/issues/1" }]);

      const added = campaignService.addIssues(campaign.id, [
        { url: "https://github.com/owner/repo/issues/1" },
        { url: "https://github.com/owner/repo/issues/2" },
      ]);

      expect(added).toBe(1); // Only the new one
    });

    it("should get issues for a campaign", () => {
      campaignService.addIssues(campaign.id, [
        { url: "https://github.com/owner/repo/issues/1" },
        { url: "https://github.com/owner/repo/issues/2" },
      ]);

      const issues = campaignService.getIssues(campaign.id);
      expect(issues).toHaveLength(2);
      expect(issues[0]?.status).toBe("pending");
    });

    it("should filter issues by status", () => {
      campaignService.addIssues(campaign.id, [
        { url: "https://github.com/owner/repo/issues/1" },
        { url: "https://github.com/owner/repo/issues/2" },
      ]);

      campaignService.updateIssueStatus(
        campaign.id,
        "https://github.com/owner/repo/issues/1",
        "completed"
      );

      const pending = campaignService.getIssues(campaign.id, {
        status: "pending",
      });
      expect(pending).toHaveLength(1);

      const completed = campaignService.getIssues(campaign.id, {
        status: "completed",
      });
      expect(completed).toHaveLength(1);
    });

    it("should update issue status with metadata", () => {
      campaignService.addIssues(campaign.id, [{ url: "https://github.com/owner/repo/issues/1" }]);

      // Update without session (sessionId has FK constraint to sessions table)
      campaignService.updateIssueStatus(
        campaign.id,
        "https://github.com/owner/repo/issues/1",
        "completed",
        {
          prUrl: "https://github.com/owner/repo/pull/10",
          costUsd: 0.05,
        }
      );

      const issue = campaignService.getCampaignIssue(
        campaign.id,
        "https://github.com/owner/repo/issues/1"
      );
      expect(issue?.status).toBe("completed");
      expect(issue?.prUrl).toBe("https://github.com/owner/repo/pull/10");
      expect(issue?.costUsd).toBe(0.05);
    });

    it("should update issue status with session reference", () => {
      // Create a real issue and session first (FK constraints)
      const testIssue = {
        id: "owner/repo#session-test",
        url: "https://github.com/owner/repo/issues/session-test",
        number: 999,
        title: "Test Issue",
        body: "",
        labels: [],
        state: "discovered" as const,
        author: "user",
        assignee: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        projectId: "owner/repo",
        hasLinkedPR: false,
        linkedPRUrl: null,
      };
      stateManager.saveIssue(testIssue);

      const session = stateManager.createSession({
        issueId: testIssue.id,
        issueUrl: testIssue.url,
        status: "active",
        provider: "claude-cli",
        model: "claude-sonnet-4-20250514",
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
        turnCount: 0,
        costUsd: 0,
        prUrl: null,
        workingDirectory: "/tmp/work",
        canResume: true,
        error: null,
      });

      campaignService.addIssues(campaign.id, [{ url: testIssue.url }]);

      campaignService.updateIssueStatus(campaign.id, testIssue.url, "completed", {
        sessionId: session.id,
      });

      const issue = campaignService.getCampaignIssue(campaign.id, testIssue.url);
      expect(issue?.sessionId).toBe(session.id);
    });

    it("should track issue attempts", () => {
      campaignService.addIssues(campaign.id, [{ url: "https://github.com/owner/repo/issues/1" }]);

      // First attempt
      campaignService.updateIssueStatus(
        campaign.id,
        "https://github.com/owner/repo/issues/1",
        "in_progress"
      );

      let issue = campaignService.getCampaignIssue(
        campaign.id,
        "https://github.com/owner/repo/issues/1"
      );
      expect(issue?.attempts).toBe(1);
      expect(issue?.startedAt).toBeDefined();

      // Failed, retry
      campaignService.updateIssueStatus(
        campaign.id,
        "https://github.com/owner/repo/issues/1",
        "pending",
        { error: "Failed first attempt" }
      );

      campaignService.updateIssueStatus(
        campaign.id,
        "https://github.com/owner/repo/issues/1",
        "in_progress"
      );

      issue = campaignService.getCampaignIssue(
        campaign.id,
        "https://github.com/owner/repo/issues/1"
      );
      expect(issue?.attempts).toBe(2);
    });

    it("should get next issue to process", () => {
      campaignService.addIssues(campaign.id, [
        { url: "https://github.com/owner/repo/issues/1", priority: 2 },
        { url: "https://github.com/owner/repo/issues/2", priority: 1 },
        { url: "https://github.com/owner/repo/issues/3", priority: 1 },
      ]);

      // Priority 1 should come first (lower = higher priority)
      const next = campaignService.getNextIssue(campaign.id);
      expect(next?.issueUrl).toBe("https://github.com/owner/repo/issues/2");
    });

    it("should remove pending issues", () => {
      campaignService.addIssues(campaign.id, [
        { url: "https://github.com/owner/repo/issues/1" },
        { url: "https://github.com/owner/repo/issues/2" },
      ]);

      const removed = campaignService.removeIssues(campaign.id, [
        "https://github.com/owner/repo/issues/1",
      ]);

      expect(removed).toBe(1);

      const issues = campaignService.getIssues(campaign.id);
      expect(issues).toHaveLength(1);
    });

    it("should not add issues to terminal campaign", () => {
      campaignService.startCampaign(campaign.id);
      campaignService.completeCampaign(campaign.id);

      expect(() => {
        campaignService.addIssues(campaign.id, [{ url: "https://github.com/owner/repo/issues/1" }]);
      }).toThrow("Cannot add issues to terminal campaign");
    });
  });

  describe("Progress and Budget", () => {
    let campaign: ReturnType<typeof campaignService.createCampaign>;

    beforeEach(() => {
      campaign = campaignService.createCampaign({
        name: "Progress Test",
        sourceType: "manual",
        budgetLimitUsd: 10,
      });

      campaignService.addIssues(campaign.id, [
        { url: "https://github.com/owner/repo/issues/1" },
        { url: "https://github.com/owner/repo/issues/2" },
        { url: "https://github.com/owner/repo/issues/3" },
        { url: "https://github.com/owner/repo/issues/4" },
      ]);
    });

    it("should calculate progress correctly", () => {
      campaignService.updateIssueStatus(
        campaign.id,
        "https://github.com/owner/repo/issues/1",
        "completed"
      );
      campaignService.updateIssueStatus(
        campaign.id,
        "https://github.com/owner/repo/issues/2",
        "failed"
      );

      const progress = campaignService.getProgress(campaign.id);
      expect(progress?.total).toBe(4);
      expect(progress?.completed).toBe(1);
      expect(progress?.failed).toBe(1);
      expect(progress?.pending).toBe(2);
      expect(progress?.progressPercent).toBe(50); // 2 out of 4 processed
    });

    it("should track budget spent", () => {
      campaignService.updateIssueStatus(
        campaign.id,
        "https://github.com/owner/repo/issues/1",
        "completed",
        { costUsd: 2.5 }
      );
      campaignService.updateIssueStatus(
        campaign.id,
        "https://github.com/owner/repo/issues/2",
        "completed",
        { costUsd: 3.0 }
      );

      const progress = campaignService.getProgress(campaign.id);
      expect(progress?.budgetSpent).toBe(5.5);
      expect(progress?.budgetLimit).toBe(10);
      expect(progress?.budgetPercent).toBe(55);
    });

    it("should detect over budget", () => {
      campaignService.addCost(campaign.id, 10);

      expect(campaignService.isOverBudget(campaign.id)).toBe(true);
    });

    it("should not be over budget without limit", () => {
      const unlimitedCampaign = campaignService.createCampaign({
        name: "No Limit",
        sourceType: "manual",
      });

      campaignService.addCost(unlimitedCampaign.id, 1000);

      expect(campaignService.isOverBudget(unlimitedCampaign.id)).toBe(false);
    });
  });
});
