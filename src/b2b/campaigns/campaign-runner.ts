/**
 * Campaign Runner
 *
 * Orchestrates campaign execution - processes issues in batch with
 * budget management and parallelism support.
 */

import { logger } from "../../infra/logger.js";
import type { CampaignService } from "./campaign-service.js";
import type {
  Campaign,
  CampaignIssue,
  CampaignRunOptions,
  CampaignRunResult,
} from "../../types/campaign.js";

/**
 * Interface for issue processor (implemented by engine or injected)
 */
export interface IssueProcessor {
  /**
   * Process a single issue
   * @returns Result with PR URL if created, cost, and success status
   */
  processIssue(
    issueUrl: string,
    options?: {
      dryRun?: boolean;
      sessionId?: string;
    }
  ): Promise<{
    success: boolean;
    prUrl?: string;
    costUsd: number;
    error?: string;
  }>;
}

/**
 * Event types emitted during campaign execution
 */
export type CampaignRunnerEvent =
  | { type: "started"; campaignId: string; totalIssues: number }
  | { type: "issue_started"; campaignId: string; issueUrl: string; index: number; total: number }
  | {
      type: "issue_completed";
      campaignId: string;
      issueUrl: string;
      prUrl?: string;
      costUsd: number;
    }
  | { type: "issue_failed"; campaignId: string; issueUrl: string; error: string }
  | { type: "issue_skipped"; campaignId: string; issueUrl: string; reason: string }
  | { type: "paused"; campaignId: string; reason: string }
  | { type: "completed"; campaignId: string; result: CampaignRunResult }
  | { type: "error"; campaignId: string; error: string };

export type CampaignRunnerEventHandler = (event: CampaignRunnerEvent) => void;

export class CampaignRunner {
  private running = false;
  private paused = false;
  private currentCampaignId: string | null = null;
  private eventHandlers: CampaignRunnerEventHandler[] = [];

  constructor(
    private campaignService: CampaignService,
    private issueProcessor: IssueProcessor
  ) {}

  /**
   * Subscribe to runner events
   */
  onEvent(handler: CampaignRunnerEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const index = this.eventHandlers.indexOf(handler);
      if (index >= 0) {
        this.eventHandlers.splice(index, 1);
      }
    };
  }

  private emit(event: CampaignRunnerEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        logger.error(`Event handler error: ${error}`);
      }
    }
  }

  /**
   * Run a campaign
   */
  async run(campaignId: string, options: CampaignRunOptions = {}): Promise<CampaignRunResult> {
    const startTime = Date.now();

    const campaign = this.campaignService.getCampaign(campaignId);
    if (!campaign) {
      throw new Error(`Campaign not found: ${campaignId}`);
    }

    if (campaign.status !== "active" && campaign.status !== "draft") {
      throw new Error(`Campaign cannot be run in status: ${campaign.status}`);
    }

    // Start campaign if in draft
    if (campaign.status === "draft") {
      this.campaignService.startCampaign(campaignId, "campaign-runner");
    }

    this.running = true;
    this.paused = false;
    this.currentCampaignId = campaignId;

    const result: CampaignRunResult = {
      campaignId,
      processed: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      totalCost: 0,
      durationSeconds: 0,
      interrupted: false,
    };

    try {
      const pendingIssues = this.campaignService.getIssues(campaignId, { status: "pending" });
      const maxIssues = options.maxIssues ?? pendingIssues.length;
      const issuesToProcess = pendingIssues.slice(0, maxIssues);

      this.emit({
        type: "started",
        campaignId,
        totalIssues: issuesToProcess.length,
      });

      logger.info(`Starting campaign ${campaign.name} with ${issuesToProcess.length} issues`);

      for (let i = 0; i < issuesToProcess.length; i++) {
        // Check for pause/stop
        if (!this.running) {
          result.interrupted = true;
          result.stopReason = "Stopped by user";
          break;
        }

        if (this.paused) {
          result.interrupted = true;
          result.stopReason = "Paused by user";
          this.emit({ type: "paused", campaignId, reason: "User requested pause" });
          break;
        }

        // Check budget
        if (this.campaignService.isOverBudget(campaignId)) {
          result.interrupted = true;
          result.stopReason = "Budget limit reached";
          this.emit({ type: "paused", campaignId, reason: "Budget limit reached" });
          this.campaignService.pauseCampaign(campaignId, "campaign-runner", "Budget limit reached");
          break;
        }

        const issue = issuesToProcess[i]!;

        // Skip if already attempted and skipRetries is set
        if (options.skipRetries && issue.attempts > 0) {
          result.skipped++;
          this.campaignService.updateIssueStatus(campaignId, issue.issueUrl, "skipped");
          this.emit({
            type: "issue_skipped",
            campaignId,
            issueUrl: issue.issueUrl,
            reason: "Already attempted",
          });
          continue;
        }

        await this.processIssue(campaign, issue, i, issuesToProcess.length, options, result);
      }

      // Check if all issues are processed
      const progress = this.campaignService.getProgress(campaignId);
      if (progress?.pending === 0 && progress.inProgress === 0) {
        this.campaignService.completeCampaign(campaignId, "campaign-runner");
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Campaign ${campaignId} error: ${errorMsg}`);
      this.emit({ type: "error", campaignId, error: errorMsg });

      if (!options.continueOnError) {
        result.interrupted = true;
        result.stopReason = errorMsg;
        this.campaignService.pauseCampaign(campaignId, "campaign-runner", errorMsg);
      }
    } finally {
      this.running = false;
      this.currentCampaignId = null;
    }

    result.durationSeconds = Math.round((Date.now() - startTime) / 1000);
    this.emit({ type: "completed", campaignId, result });

    return result;
  }

  /**
   * Process a single issue
   */
  private async processIssue(
    campaign: Campaign,
    issue: CampaignIssue,
    index: number,
    total: number,
    options: CampaignRunOptions,
    result: CampaignRunResult
  ): Promise<void> {
    const { issueUrl } = issue;

    this.emit({
      type: "issue_started",
      campaignId: campaign.id,
      issueUrl,
      index: index + 1,
      total,
    });

    // Mark as in progress
    this.campaignService.updateIssueStatus(campaign.id, issueUrl, "in_progress");

    try {
      logger.info(`Processing issue ${index + 1}/${total}: ${issueUrl}`);

      const processResult = await this.issueProcessor.processIssue(
        issueUrl,
        options.dryRun !== undefined ? { dryRun: options.dryRun } : {}
      );

      result.processed++;
      result.totalCost += processResult.costUsd;

      if (processResult.success) {
        result.completed++;
        const statusUpdate: { prUrl?: string; costUsd: number } = {
          costUsd: processResult.costUsd,
        };
        if (processResult.prUrl) {
          statusUpdate.prUrl = processResult.prUrl;
        }
        this.campaignService.updateIssueStatus(campaign.id, issueUrl, "completed", statusUpdate);
        this.campaignService.addCost(campaign.id, processResult.costUsd);

        const completedEvent: {
          type: "issue_completed";
          campaignId: string;
          issueUrl: string;
          prUrl?: string;
          costUsd: number;
        } = {
          type: "issue_completed",
          campaignId: campaign.id,
          issueUrl,
          costUsd: processResult.costUsd,
        };
        if (processResult.prUrl) {
          completedEvent.prUrl = processResult.prUrl;
        }
        this.emit(completedEvent);

        logger.info(
          `Completed issue: ${issueUrl}${processResult.prUrl ? ` -> ${processResult.prUrl}` : ""}`
        );
      } else {
        result.failed++;
        const statusUpdate: { error?: string; costUsd: number } = {
          costUsd: processResult.costUsd,
        };
        if (processResult.error) {
          statusUpdate.error = processResult.error;
        }
        this.campaignService.updateIssueStatus(campaign.id, issueUrl, "failed", statusUpdate);
        this.campaignService.addCost(campaign.id, processResult.costUsd);

        this.emit({
          type: "issue_failed",
          campaignId: campaign.id,
          issueUrl,
          error: processResult.error ?? "Unknown error",
        });

        logger.warn(`Failed issue: ${issueUrl} - ${processResult.error}`);
      }
    } catch (error) {
      result.failed++;
      const errorMsg = error instanceof Error ? error.message : String(error);

      this.campaignService.updateIssueStatus(campaign.id, issueUrl, "failed", {
        error: errorMsg,
      });

      this.emit({
        type: "issue_failed",
        campaignId: campaign.id,
        issueUrl,
        error: errorMsg,
      });

      logger.error(`Error processing issue ${issueUrl}: ${errorMsg}`);

      if (!options.continueOnError) {
        throw error;
      }
    }
  }

  /**
   * Pause the current run
   */
  pause(): void {
    if (this.running) {
      this.paused = true;
      logger.info("Campaign runner pause requested");
    }
  }

  /**
   * Stop the current run
   */
  stop(): void {
    if (this.running) {
      this.running = false;
      logger.info("Campaign runner stop requested");
    }
  }

  /**
   * Check if runner is active
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get current campaign ID
   */
  getCurrentCampaignId(): string | null {
    return this.currentCampaignId;
  }
}

/**
 * Create a simple issue processor for testing/dry runs
 */
export function createDryRunProcessor(): IssueProcessor {
  return {
    async processIssue(
      issueUrl: string,
      options?: { dryRun?: boolean; sessionId?: string }
    ): Promise<{ success: boolean; prUrl?: string; costUsd: number; error?: string }> {
      logger.info(`[DRY RUN] Would process: ${issueUrl}`);
      // Simulate some processing time
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result: { success: boolean; prUrl?: string; costUsd: number; error?: string } = {
        success: true,
        costUsd: 0.05, // Simulated cost
      };

      if (!options?.dryRun) {
        result.prUrl = `https://github.com/example/repo/pull/123`;
      }

      return result;
    },
  };
}
