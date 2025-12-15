/**
 * Campaign CLI Commands
 *
 * Commands for managing batch operations on issues.
 */

import { Command } from "commander";
import pc from "picocolors";
import ora from "ora";
import { StateManager } from "../../core/state/state-manager.js";
import { CampaignService, CampaignRunner, createDryRunProcessor } from "../../b2b/index.js";
import type { CampaignStatus, CampaignSourceType } from "../../types/campaign.js";
import { loadConfig, getConfigDir } from "../config/loader.js";

export function createCampaignCommand(): Command {
  const campaign = new Command("campaign").description(
    "Manage campaigns for batch issue processing"
  );

  // List campaigns
  campaign
    .command("list")
    .description("List all campaigns")
    .option(
      "-s, --status <status>",
      "Filter by status (draft, active, paused, completed, cancelled)"
    )
    .option("--source <type>", "Filter by source type")
    .option("--search <query>", "Search in name/description")
    .action(async (options) => {
      await loadConfig(); // Ensure config is initialized
      const dataDir = getConfigDir();
      const stateManager = new StateManager(dataDir);
      const campaignService = new CampaignService(stateManager["db"]);

      const filters: { status?: CampaignStatus; sourceType?: CampaignSourceType; search?: string } =
        {};
      if (options.status) {
        filters.status = options.status as CampaignStatus;
      }
      if (options.source) {
        filters.sourceType = options.source as CampaignSourceType;
      }
      if (options.search) {
        filters.search = options.search;
      }
      const campaigns = campaignService.listCampaigns(filters);

      if (campaigns.length === 0) {
        console.log(pc.dim("No campaigns found."));
        return;
      }

      console.log(pc.bold(`\nCampaigns (${campaigns.length}):\n`));

      for (const c of campaigns) {
        const statusColor = getStatusColor(c.status);
        const progress =
          c.totalIssues > 0
            ? Math.round(
                ((c.completedIssues + c.failedIssues + c.skippedIssues) / c.totalIssues) * 100
              )
            : 0;

        console.log(`  ${pc.bold(c.name)} ${pc.dim(`(${c.id.slice(0, 8)}...)`)}`);
        console.log(
          `    Status: ${statusColor(c.status)}  Issues: ${c.totalIssues}  Progress: ${progress}%`
        );
        if (c.budgetLimitUsd) {
          console.log(
            `    Budget: $${c.budgetSpentUsd.toFixed(2)} / $${c.budgetLimitUsd.toFixed(2)}`
          );
        }
        console.log();
      }
    });

  // Create campaign
  campaign
    .command("create")
    .description("Create a new campaign")
    .argument("<name>", "Campaign name")
    .option("-d, --description <text>", "Campaign description")
    .option(
      "-s, --source <type>",
      "Source type (manual, jira_jql, linear_filter, github_search)",
      "manual"
    )
    .option("-b, --budget <usd>", "Budget limit in USD")
    .option("-t, --tags <tags>", "Comma-separated tags")
    .action(async (name, options) => {
      await loadConfig(); // Ensure config is initialized
      const dataDir = getConfigDir();
      const stateManager = new StateManager(dataDir);
      const campaignService = new CampaignService(stateManager["db"]);

      const createOptions: {
        name: string;
        sourceType: CampaignSourceType;
        description?: string;
        budgetLimitUsd?: number;
        tags?: string[];
      } = {
        name,
        sourceType: options.source as CampaignSourceType,
      };
      if (options.description) {
        createOptions.description = options.description;
      }
      if (options.budget) {
        createOptions.budgetLimitUsd = parseFloat(options.budget);
      }
      if (options.tags) {
        createOptions.tags = options.tags.split(",").map((t: string) => t.trim());
      }
      const campaign = campaignService.createCampaign(createOptions);

      console.log(pc.green(`✓ Created campaign: ${campaign.name}`));
      console.log(pc.dim(`  ID: ${campaign.id}`));
    });

  // Show campaign details
  campaign
    .command("show")
    .description("Show campaign details")
    .argument("<id>", "Campaign ID (or prefix)")
    .action(async (id) => {
      await loadConfig(); // Ensure config is initialized
      const dataDir = getConfigDir();
      const stateManager = new StateManager(dataDir);
      const campaignService = new CampaignService(stateManager["db"]);

      const campaign = findCampaign(campaignService, id);
      if (!campaign) {
        console.error(pc.red(`Campaign not found: ${id}`));
        process.exit(1);
      }

      const progress = campaignService.getProgress(campaign.id);
      const statusColor = getStatusColor(campaign.status);

      console.log(pc.bold(`\n${campaign.name}\n`));
      console.log(`ID:          ${campaign.id}`);
      console.log(`Status:      ${statusColor(campaign.status)}`);
      console.log(`Source:      ${campaign.sourceType}`);
      console.log(`Created:     ${new Date(campaign.createdAt).toLocaleString()}`);
      if (campaign.startedAt) {
        console.log(`Started:     ${new Date(campaign.startedAt).toLocaleString()}`);
      }
      if (campaign.completedAt) {
        console.log(`Completed:   ${new Date(campaign.completedAt).toLocaleString()}`);
      }
      if (campaign.description) {
        console.log(`Description: ${campaign.description}`);
      }
      if (campaign.tags?.length) {
        console.log(`Tags:        ${campaign.tags.join(", ")}`);
      }

      console.log(pc.bold("\nProgress:"));
      if (progress) {
        console.log(`  Total:       ${progress.total}`);
        console.log(`  Pending:     ${progress.pending}`);
        console.log(`  In Progress: ${progress.inProgress}`);
        console.log(`  Completed:   ${pc.green(String(progress.completed))}`);
        console.log(`  Failed:      ${pc.red(String(progress.failed))}`);
        console.log(`  Skipped:     ${pc.yellow(String(progress.skipped))}`);
        console.log(`  Progress:    ${progress.progressPercent}%`);
      }

      console.log(pc.bold("\nBudget:"));
      console.log(`  Spent:       $${campaign.budgetSpentUsd.toFixed(2)}`);
      if (campaign.budgetLimitUsd) {
        console.log(`  Limit:       $${campaign.budgetLimitUsd.toFixed(2)}`);
        const budgetPercent = Math.round((campaign.budgetSpentUsd / campaign.budgetLimitUsd) * 100);
        console.log(`  Used:        ${budgetPercent}%`);
      }

      console.log();
    });

  // Add issues to campaign
  campaign
    .command("add-issues")
    .description("Add issues to a campaign")
    .argument("<id>", "Campaign ID")
    .argument("<urls...>", "Issue URLs to add")
    .action(async (id, urls) => {
      await loadConfig(); // Ensure config is initialized
      const dataDir = getConfigDir();
      const stateManager = new StateManager(dataDir);
      const campaignService = new CampaignService(stateManager["db"]);

      const campaign = findCampaign(campaignService, id);
      if (!campaign) {
        console.error(pc.red(`Campaign not found: ${id}`));
        process.exit(1);
      }

      const added = campaignService.addIssues(
        campaign.id,
        urls.map((url: string) => ({ url }))
      );

      console.log(pc.green(`✓ Added ${added} issues to campaign "${campaign.name}"`));
    });

  // Start campaign
  campaign
    .command("start")
    .description("Start a campaign")
    .argument("<id>", "Campaign ID")
    .action(async (id) => {
      await loadConfig(); // Ensure config is initialized
      const dataDir = getConfigDir();
      const stateManager = new StateManager(dataDir);
      const campaignService = new CampaignService(stateManager["db"]);

      const campaign = findCampaign(campaignService, id);
      if (!campaign) {
        console.error(pc.red(`Campaign not found: ${id}`));
        process.exit(1);
      }

      campaignService.startCampaign(campaign.id, "cli");
      console.log(pc.green(`✓ Started campaign "${campaign.name}"`));
    });

  // Pause campaign
  campaign
    .command("pause")
    .description("Pause a running campaign")
    .argument("<id>", "Campaign ID")
    .option("-r, --reason <text>", "Reason for pausing")
    .action(async (id, options) => {
      await loadConfig(); // Ensure config is initialized
      const dataDir = getConfigDir();
      const stateManager = new StateManager(dataDir);
      const campaignService = new CampaignService(stateManager["db"]);

      const campaign = findCampaign(campaignService, id);
      if (!campaign) {
        console.error(pc.red(`Campaign not found: ${id}`));
        process.exit(1);
      }

      campaignService.pauseCampaign(campaign.id, "cli", options.reason);
      console.log(pc.yellow(`⏸ Paused campaign "${campaign.name}"`));
    });

  // Resume campaign
  campaign
    .command("resume")
    .description("Resume a paused campaign")
    .argument("<id>", "Campaign ID")
    .action(async (id) => {
      await loadConfig(); // Ensure config is initialized
      const dataDir = getConfigDir();
      const stateManager = new StateManager(dataDir);
      const campaignService = new CampaignService(stateManager["db"]);

      const campaign = findCampaign(campaignService, id);
      if (!campaign) {
        console.error(pc.red(`Campaign not found: ${id}`));
        process.exit(1);
      }

      campaignService.resumeCampaign(campaign.id, "cli");
      console.log(pc.green(`▶ Resumed campaign "${campaign.name}"`));
    });

  // Cancel campaign
  campaign
    .command("cancel")
    .description("Cancel a campaign")
    .argument("<id>", "Campaign ID")
    .option("-r, --reason <text>", "Reason for cancelling")
    .action(async (id, options) => {
      await loadConfig(); // Ensure config is initialized
      const dataDir = getConfigDir();
      const stateManager = new StateManager(dataDir);
      const campaignService = new CampaignService(stateManager["db"]);

      const campaign = findCampaign(campaignService, id);
      if (!campaign) {
        console.error(pc.red(`Campaign not found: ${id}`));
        process.exit(1);
      }

      campaignService.cancelCampaign(campaign.id, "cli", options.reason);
      console.log(pc.red(`✗ Cancelled campaign "${campaign.name}"`));
    });

  // Run campaign
  campaign
    .command("run")
    .description("Run a campaign (process issues)")
    .argument("<id>", "Campaign ID")
    .option("-n, --max-issues <n>", "Maximum issues to process")
    .option("--dry-run", "Dry run (don't actually process)")
    .option("--continue-on-error", "Continue processing after failures")
    .action(async (id, options) => {
      await loadConfig(); // Ensure config is initialized
      const dataDir = getConfigDir();
      const stateManager = new StateManager(dataDir);
      const campaignService = new CampaignService(stateManager["db"]);

      const campaign = findCampaign(campaignService, id);
      if (!campaign) {
        console.error(pc.red(`Campaign not found: ${id}`));
        process.exit(1);
      }

      // Use dry run processor for now (real processor would come from engine)
      const processor = createDryRunProcessor();
      const runner = new CampaignRunner(campaignService, processor);

      const spinner = ora(`Running campaign "${campaign.name}"...`).start();

      runner.onEvent((event) => {
        switch (event.type) {
          case "started":
            spinner.text = `Processing ${event.totalIssues} issues...`;
            break;
          case "issue_started":
            spinner.text = `[${event.index}/${event.total}] Processing ${event.issueUrl}`;
            break;
          case "issue_completed":
            spinner.succeed(`Completed: ${event.issueUrl}`);
            spinner.start();
            break;
          case "issue_failed":
            spinner.fail(`Failed: ${event.issueUrl} - ${event.error}`);
            spinner.start();
            break;
          case "issue_skipped":
            spinner.warn(`Skipped: ${event.issueUrl} - ${event.reason}`);
            spinner.start();
            break;
          case "completed":
            spinner.stop();
            break;
        }
      });

      const runOptions: { maxIssues?: number; dryRun?: boolean; continueOnError?: boolean } = {};
      if (options.maxIssues) {
        runOptions.maxIssues = parseInt(options.maxIssues);
      }
      if (options.dryRun) {
        runOptions.dryRun = options.dryRun;
      }
      if (options.continueOnError) {
        runOptions.continueOnError = options.continueOnError;
      }
      const result = await runner.run(campaign.id, runOptions);

      console.log(pc.bold("\nResults:"));
      console.log(`  Processed: ${result.processed}`);
      console.log(`  Completed: ${pc.green(String(result.completed))}`);
      console.log(`  Failed:    ${pc.red(String(result.failed))}`);
      console.log(`  Skipped:   ${pc.yellow(String(result.skipped))}`);
      console.log(`  Cost:      $${result.totalCost.toFixed(2)}`);
      console.log(`  Duration:  ${result.durationSeconds}s`);

      if (result.interrupted) {
        console.log(pc.yellow(`\nInterrupted: ${result.stopReason}`));
      }
    });

  // Show campaign issues
  campaign
    .command("issues")
    .description("List issues in a campaign")
    .argument("<id>", "Campaign ID")
    .option("-s, --status <status>", "Filter by status")
    .option("--failed", "Show only failed issues")
    .option("--pending", "Show only pending issues")
    .action(async (id, options) => {
      await loadConfig(); // Ensure config is initialized
      const dataDir = getConfigDir();
      const stateManager = new StateManager(dataDir);
      const campaignService = new CampaignService(stateManager["db"]);

      const campaign = findCampaign(campaignService, id);
      if (!campaign) {
        console.error(pc.red(`Campaign not found: ${id}`));
        process.exit(1);
      }

      let statusFilter = options.status;
      if (options.failed) statusFilter = "failed";
      if (options.pending) statusFilter = "pending";

      const issues = campaignService.getIssues(campaign.id, {
        status: statusFilter,
      });

      if (issues.length === 0) {
        console.log(pc.dim("No issues found."));
        return;
      }

      console.log(pc.bold(`\nIssues in "${campaign.name}" (${issues.length}):\n`));

      for (const issue of issues) {
        const statusColor = getIssueStatusColor(issue.status);
        console.log(`  ${statusColor(issue.status.padEnd(12))} ${issue.issueUrl}`);
        if (issue.prUrl) {
          console.log(`  ${pc.dim("            ")} → ${pc.cyan(issue.prUrl)}`);
        }
        if (issue.error) {
          console.log(`  ${pc.dim("            ")} ${pc.red(issue.error)}`);
        }
      }
      console.log();
    });

  // Delete campaign
  campaign
    .command("delete")
    .description("Delete a campaign")
    .argument("<id>", "Campaign ID")
    .option("-f, --force", "Force delete without confirmation")
    .action(async (id, options) => {
      await loadConfig(); // Ensure config is initialized
      const dataDir = getConfigDir();
      const stateManager = new StateManager(dataDir);
      const campaignService = new CampaignService(stateManager["db"]);

      const campaign = findCampaign(campaignService, id);
      if (!campaign) {
        console.error(pc.red(`Campaign not found: ${id}`));
        process.exit(1);
      }

      if (!options.force) {
        console.log(
          pc.yellow(`Warning: This will delete campaign "${campaign.name}" and all its issues.`)
        );
        console.log(pc.dim("Use --force to confirm."));
        process.exit(1);
      }

      campaignService.deleteCampaign(campaign.id);
      console.log(pc.green(`✓ Deleted campaign "${campaign.name}"`));
    });

  return campaign;
}

// Helper functions

function findCampaign(service: CampaignService, idOrPrefix: string) {
  // Try exact match first
  const campaign = service.getCampaign(idOrPrefix);
  if (campaign) return campaign;

  // Try prefix match
  const campaigns = service.listCampaigns();
  const matches = campaigns.filter((c) => c.id.startsWith(idOrPrefix));

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    console.error(pc.yellow(`Multiple campaigns match prefix "${idOrPrefix}":`));
    for (const m of matches) {
      console.error(`  ${m.id} - ${m.name}`);
    }
    return null;
  }

  return null;
}

function getStatusColor(status: CampaignStatus) {
  switch (status) {
    case "draft":
      return pc.dim;
    case "active":
      return pc.green;
    case "paused":
      return pc.yellow;
    case "completed":
      return pc.blue;
    case "cancelled":
      return pc.red;
    default:
      return pc.white;
  }
}

function getIssueStatusColor(status: string) {
  switch (status) {
    case "pending":
      return pc.dim;
    case "queued":
      return pc.cyan;
    case "in_progress":
      return pc.yellow;
    case "completed":
      return pc.green;
    case "failed":
      return pc.red;
    case "skipped":
      return pc.gray;
    default:
      return pc.white;
  }
}
