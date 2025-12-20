import { Command } from "commander";
import pc from "picocolors";
import { writeFileSync } from "node:fs";
import { logger } from "../../infra/logger.js";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { GitOperations } from "../../core/git/git-operations.js";
import { createProvider } from "../../core/ai/provider-factory.js";
import { AuditService } from "../../core/audit/audit-service.js";
import type {
  AuditCategory,
  AuditResult,
  AuditSeverity,
  AuditConfidence,
} from "../../types/audit.js";

export function createAuditCommand(): Command {
  const audit = new Command("audit")
    .description("Audit a repository for potential issues")
    .argument("[repo-url]", "Repository URL to audit")
    .option(
      "-c, --categories <categories>",
      "Categories to audit (comma-separated)",
      "security,documentation,code-quality"
    )
    .option("--discover", "Discover and audit multiple repositories")
    .option("--max-repos <n>", "Max repos to audit in discover mode", "5")
    .option("--skip-issues", "Don't create GitHub issues for findings")
    .option("--skip-resolve", "Don't auto-resolve findings")
    .option("--min-severity <level>", "Minimum severity to report", "medium")
    .option("--min-confidence <level>", "Minimum confidence to report", "medium")
    .option("--report <path>", "Save report to file")
    .option("--json", "Output results as JSON", false)
    .option("-v, --verbose", "Enable verbose output", false)
    .action(async (repoUrl: string | undefined, options: AuditCommandOptions) => {
      if (options.verbose) {
        logger.configure({ level: "debug", verbose: true });
      }

      try {
        await runAudit(repoUrl, options);
      } catch (error) {
        logger.error("Audit failed", error);
        process.exit(1);
      }
    });

  return audit;
}

interface AuditCommandOptions {
  categories: string;
  discover?: boolean;
  maxRepos?: string;
  skipIssues?: boolean;
  skipResolve?: boolean;
  minSeverity?: string;
  minConfidence?: string;
  report?: string;
  json: boolean;
  verbose: boolean;
}

async function runAudit(repoUrl: string | undefined, options: AuditCommandOptions): Promise<void> {
  // Validate: either repoUrl or --discover required
  if (!repoUrl && !options.discover) {
    logger.error("Either <repo-url> or --discover flag is required");
    process.exit(1);
  }

  // Load config and initialize services
  const config = loadConfig();
  const dataDir = expandPath(config.dataDir);
  const stateManager = new StateManager(dataDir);
  const gitOps = new GitOperations(config.git, dataDir);

  try {
    const aiProvider = await createProvider(config);

    // Check AI provider availability
    const available = await aiProvider.isAvailable();
    if (!available) {
      logger.error(`AI provider '${aiProvider.name}' is not available.`);
      if (config.ai.executionMode === "sdk") {
        logger.info("Hint: Set ANTHROPIC_API_KEY or switch to CLI mode:");
        logger.info("  oss-agent config set ai.executionMode cli");
      } else {
        logger.info("Hint: Ensure 'claude' CLI is installed and authenticated");
      }
      stateManager.close();
      process.exit(1);
    }

    // Parse categories
    const categories = options.categories.split(",").map((c) => c.trim()) as AuditCategory[];

    // Validate categories
    const validCategories: AuditCategory[] = [
      "security",
      "performance",
      "documentation",
      "code-quality",
      "test-coverage",
    ];
    for (const cat of categories) {
      if (!validCategories.includes(cat)) {
        logger.error(`Invalid category: ${cat}. Valid categories: ${validCategories.join(", ")}`);
        stateManager.close();
        process.exit(1);
      }
    }

    if (options.discover) {
      await runDiscoverMode(config, stateManager, gitOps, aiProvider, categories, options);
    } else {
      await runSingleAudit(config, stateManager, gitOps, aiProvider, repoUrl!, categories, options);
    }
  } finally {
    stateManager.close();
  }
}

async function runSingleAudit(
  config: ReturnType<typeof loadConfig>,
  stateManager: StateManager,
  gitOps: GitOperations,
  aiProvider: Awaited<ReturnType<typeof createProvider>>,
  repoUrl: string,
  categories: AuditCategory[],
  options: AuditCommandOptions
): Promise<void> {
  if (!options.json) {
    logger.header("OSS Agent - Repository Audit");
    logger.info(`Repository: ${pc.cyan(repoUrl)}`);
    logger.info(`Categories: ${pc.cyan(categories.join(", "))}`);
    logger.info(`AI Provider: ${pc.green(aiProvider.name)}`);

    if (options.skipIssues) {
      logger.info("Issue creation: " + pc.yellow("disabled"));
    }
    if (options.skipResolve) {
      logger.info("Auto-resolve: " + pc.yellow("disabled"));
    }
    logger.info(`Min severity: ${pc.cyan(options.minSeverity ?? "medium")}`);
    logger.info(`Min confidence: ${pc.cyan(options.minConfidence ?? "medium")}`);
    console.error("");
  }

  // Create AuditService and run the audit
  const auditService = new AuditService(config, stateManager, gitOps, aiProvider);

  // Build options object, only including defined properties
  const auditOptions: Parameters<typeof auditService.auditRepository>[0] = {
    repoUrl,
    categories,
  };
  if (options.skipIssues !== undefined) {
    auditOptions.skipIssueCreation = options.skipIssues;
  }
  if (options.skipResolve !== undefined) {
    auditOptions.skipAutoResolve = options.skipResolve;
  }
  if (options.minSeverity) {
    auditOptions.minSeverity = options.minSeverity as AuditSeverity;
  }
  if (options.minConfidence) {
    auditOptions.minConfidence = options.minConfidence as AuditConfidence;
  }

  const result = await auditService.auditRepository(auditOptions);

  // Display results
  if (options.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
  } else {
    displayAuditResults(result);
  }

  // Save report if requested
  if (options.report) {
    await saveReport(result, options.report);
  }
}

async function runDiscoverMode(
  _config: ReturnType<typeof loadConfig>,
  _stateManager: StateManager,
  _gitOps: GitOperations,
  aiProvider: Awaited<ReturnType<typeof createProvider>>,
  categories: AuditCategory[],
  options: AuditCommandOptions
): Promise<void> {
  if (!options.json) {
    logger.header("OSS Agent - Discover & Audit");
    logger.info(`Max repos: ${pc.cyan(options.maxRepos ?? "5")}`);
    logger.info(`Categories: ${pc.cyan(categories.join(", "))}`);
    logger.info(`AI Provider: ${pc.green(aiProvider.name)}`);
    console.error("");
  }

  // TODO: Implement discover mode
  // Use DiscoveryService to find repos
  // Audit each one up to maxRepos
  logger.warn("Discover mode not yet fully implemented - use direct repo URL");
  logger.info("Example: oss-agent audit https://github.com/owner/repo");
}

function displayAuditResults(result: AuditResult): void {
  console.error("");
  logger.header("Audit Results");
  console.error("");

  // Summary stats
  console.error(pc.bold("Summary:"));
  console.error(
    `  Total findings: ${result.summary.totalFindings > 0 ? pc.yellow(result.summary.totalFindings.toString()) : pc.green("0")}`
  );

  if (result.summary.totalFindings > 0) {
    console.error("");
    console.error(pc.bold("By Severity:"));
    const { bySeverity } = result.summary;
    if (bySeverity.critical > 0) {
      console.error(`  Critical: ${pc.red(bySeverity.critical.toString())}`);
    }
    if (bySeverity.high > 0) {
      console.error(`  High: ${pc.red(bySeverity.high.toString())}`);
    }
    if (bySeverity.medium > 0) {
      console.error(`  Medium: ${pc.yellow(bySeverity.medium.toString())}`);
    }
    if (bySeverity.low > 0) {
      console.error(`  Low: ${pc.cyan(bySeverity.low.toString())}`);
    }
    if (bySeverity.info > 0) {
      console.error(`  Info: ${pc.dim(bySeverity.info.toString())}`);
    }

    console.error("");
    console.error(pc.bold("By Category:"));
    for (const [category, count] of Object.entries(result.summary.byCategory)) {
      if (count > 0) {
        console.error(`  ${category}: ${count}`);
      }
    }

    // Show top findings
    if (result.findings.length > 0) {
      console.error("");
      console.error(pc.bold("Top Findings:"));
      const topFindings = result.findings
        .sort((a, b) => {
          const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
          return severityOrder[a.severity] - severityOrder[b.severity];
        })
        .slice(0, 5);

      for (const finding of topFindings) {
        const severityColor =
          finding.severity === "critical" || finding.severity === "high"
            ? pc.red
            : finding.severity === "medium"
              ? pc.yellow
              : pc.dim;
        console.error(`  ${severityColor(`[${finding.severity}]`)} ${finding.title}`);
        if (finding.filePath) {
          console.error(
            pc.dim(`    → ${finding.filePath}${finding.lineNumber ? `:${finding.lineNumber}` : ""}`)
          );
        }
      }
    }
  } else {
    console.error("");
    console.error(pc.green("No issues found! Repository looks good."));
  }

  // Metrics
  console.error("");
  console.error(pc.dim("Metrics:"));
  console.error(`  Duration: ${((result.run.durationMs ?? 0) / 1000).toFixed(1)}s`);
  if (result.run.costUsd > 0) {
    console.error(`  Cost: $${result.run.costUsd.toFixed(4)}`);
  }

  console.error("");
}

async function saveReport(result: AuditResult, path: string): Promise<void> {
  try {
    writeFileSync(path, JSON.stringify(result, null, 2));
    logger.success(`Report saved to: ${path}`);
  } catch (error) {
    logger.error(`Failed to save report to ${path}`, error);
  }
}
