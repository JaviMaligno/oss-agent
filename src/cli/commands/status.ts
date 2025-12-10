import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig, getConfigDir } from "../config/loader.js";

export function createStatusCommand(): Command {
  const command = new Command("status")
    .description("Show current agent status, budget usage, and active sessions")
    .option("-v, --verbose", "Show detailed status", false)
    .action(async (options: { verbose: boolean }) => {
      if (options.verbose) {
        logger.configure({ level: "debug", verbose: true });
      }

      logger.header("OSS Agent - Status");

      const config = loadConfig();

      // Configuration summary
      console.error(pc.bold("Configuration"));
      console.error(pc.dim("─".repeat(40)));
      console.error(`  Mode:        ${pc.cyan(config.mode)}`);
      console.error(`  AI Provider: ${pc.cyan(config.ai.provider)}`);
      console.error(`  Model:       ${pc.cyan(config.ai.model)}`);
      console.error(`  Data dir:    ${pc.dim(getConfigDir())}`);
      console.error("");

      // Budget summary
      console.error(pc.bold("Budget"));
      console.error(pc.dim("─".repeat(40)));
      console.error(`  Daily limit:     ${pc.yellow(`$${config.budget.dailyLimitUsd}`)}`);
      console.error(`  Monthly limit:   ${pc.yellow(`$${config.budget.monthlyLimitUsd}`)}`);
      console.error(`  Per-issue limit: ${pc.yellow(`$${config.budget.perIssueLimitUsd}`)}`);
      console.error("");

      // TODO: Phase 2 - Show actual usage from database
      console.error(pc.bold("Usage (today)"));
      console.error(pc.dim("─".repeat(40)));
      console.error(
        `  Spent:     ${pc.green("$0.00")} / ${pc.dim(`$${config.budget.dailyLimitUsd}`)}`
      );
      console.error(
        `  PRs:       ${pc.green("0")} / ${pc.dim(config.oss?.qualityGates.maxPrsPerDay?.toString() ?? "10")}`
      );
      console.error(`  Issues:    ${pc.green("0")} in progress`);
      console.error("");

      // Active sessions placeholder
      console.error(pc.bold("Active Sessions"));
      console.error(pc.dim("─".repeat(40)));
      console.error(pc.dim("  No active sessions"));
      console.error("");

      console.error(pc.dim("📋 Full status tracking will be available in Phase 2"));
    });

  return command;
}
