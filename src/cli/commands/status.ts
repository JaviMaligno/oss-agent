import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig, getConfigDir } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { BudgetManager } from "../../core/engine/budget-manager.js";

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
      const dataDir = getConfigDir();
      const stateManager = new StateManager(dataDir);

      try {
        const budgetManager = new BudgetManager(stateManager, config.budget);

        // Configuration summary
        console.error(pc.bold("Configuration"));
        console.error(pc.dim("─".repeat(40)));
        console.error(`  Mode:        ${pc.cyan(config.mode)}`);
        console.error(`  AI Provider: ${pc.cyan(config.ai.provider)}`);
        console.error(`  Model:       ${pc.cyan(config.ai.model)}`);
        console.error(`  Data dir:    ${pc.dim(dataDir)}`);
        console.error("");

        // Budget summary
        console.error(pc.bold("Budget"));
        console.error(pc.dim("─".repeat(40)));
        console.error(`  Daily limit:     ${pc.yellow(`$${config.budget.dailyLimitUsd}`)}`);
        console.error(`  Monthly limit:   ${pc.yellow(`$${config.budget.monthlyLimitUsd}`)}`);
        console.error(`  Per-issue limit: ${pc.yellow(`$${config.budget.perIssueLimitUsd}`)}`);
        console.error("");

        // Get real usage data from database
        const budgetStatus = budgetManager.getStatus();
        const prCounts = stateManager.getTodaysPRCounts();
        const inProgressIssues = stateManager.getIssuesByState("in_progress");
        const activeSessions = stateManager.getActiveSessions();

        // Usage section with real data
        console.error(pc.bold("Usage (today)"));
        console.error(pc.dim("─".repeat(40)));

        const spentColor =
          budgetStatus.todaysCost > config.budget.dailyLimitUsd * 0.8 ? pc.yellow : pc.green;
        console.error(
          `  Spent:     ${spentColor(`$${budgetStatus.todaysCost.toFixed(2)}`)} / ${pc.dim(`$${config.budget.dailyLimitUsd}`)}`
        );

        const maxPrsPerDay = config.oss?.qualityGates.maxPrsPerDay ?? 10;
        const prColor = prCounts.daily >= maxPrsPerDay ? pc.yellow : pc.green;
        console.error(
          `  PRs:       ${prColor(prCounts.daily.toString())} / ${pc.dim(maxPrsPerDay.toString())}`
        );

        console.error(`  Issues:    ${pc.green(inProgressIssues.length.toString())} in progress`);
        console.error("");

        // Monthly usage
        console.error(pc.bold("Usage (this month)"));
        console.error(pc.dim("─".repeat(40)));
        const monthlyColor =
          budgetStatus.monthsCost > config.budget.monthlyLimitUsd * 0.8 ? pc.yellow : pc.green;
        console.error(
          `  Spent:     ${monthlyColor(`$${budgetStatus.monthsCost.toFixed(2)}`)} / ${pc.dim(`$${config.budget.monthlyLimitUsd}`)}`
        );
        console.error("");

        // Active sessions
        console.error(pc.bold("Active Sessions"));
        console.error(pc.dim("─".repeat(40)));
        if (activeSessions.length === 0) {
          console.error(pc.dim("  No active sessions"));
        } else {
          for (const session of activeSessions) {
            const duration = Math.round((Date.now() - session.startedAt.getTime()) / 1000 / 60);
            console.error(`  ${pc.cyan(session.id)}`);
            console.error(`    Issue: ${pc.dim(session.issueUrl)}`);
            console.error(
              `    Duration: ${duration}m | Turns: ${session.turnCount} | Cost: $${session.costUsd.toFixed(2)}`
            );
          }
        }
        console.error("");

        // Statistics summary
        const stats = stateManager.getStats();
        console.error(pc.bold("Statistics"));
        console.error(pc.dim("─".repeat(40)));
        console.error(`  Total issues:   ${stats.totalIssues}`);
        console.error(`  Total sessions: ${stats.totalSessions}`);
        console.error(`  Total spent:    $${stats.totalCostUsd.toFixed(2)}`);
        console.error("");
      } finally {
        stateManager.close();
      }
    });

  return command;
}
