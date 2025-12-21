import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig } from "../config/loader.js";
import { DiscoveryService } from "../../oss/discovery/index.js";
import { SelectionService } from "../../oss/selection/index.js";
import type { GitHubIssueInfo } from "../../types/issue.js";
import type { Project } from "../../types/project.js";

export function createSuggestCommand(): Command {
  const command = new Command("suggest")
    .description("Find and suggest issues to work on from a project")
    .argument("[repo]", "Repository (owner/repo) or URL")
    .option("-l, --labels <labels...>", "Filter by labels (e.g., 'good first issue')")
    .option("--exclude-labels <labels...>", "Exclude issues with these labels")
    .option("-n, --limit <n>", "Maximum number of issues to return", parseInt, 10)
    .option("--no-pr-filter", "Include issues that may already have PRs")
    .option("--include-assigned", "Include issues that are assigned to someone")
    .option("--include-closed", "Include closed issues (default: open only)")
    .option("--score", "Show legacy issue scores", false)
    .option("--roi", "Show ROI analysis (feasibility × impact / cost)", false)
    .option("--json", "Output as JSON", false)
    .option("-v, --verbose", "Enable verbose output", false)
    .action(async (repo: string | undefined, options: SuggestOptions) => {
      if (options.verbose) {
        logger.configure({ level: "debug", verbose: true });
      }

      try {
        await runSuggest(repo, options);
      } catch (error) {
        logger.error("Suggest failed", error);
        process.exit(1);
      }
    });

  return command;
}

interface SuggestOptions {
  labels?: string[] | undefined;
  excludeLabels?: string[] | undefined;
  limit: number;
  prFilter: boolean;
  includeAssigned: boolean;
  includeClosed: boolean;
  score: boolean;
  roi: boolean;
  json: boolean;
  verbose: boolean;
}

async function runSuggest(repo: string | undefined, options: SuggestOptions): Promise<void> {
  if (!options.json) {
    logger.header("OSS Agent - Suggest Issues");
  }

  const config = loadConfig();
  const ossConfig = config.oss;

  // Get project
  let project: Project | null = null;

  if (repo) {
    // User provided a repo
    const discoveryService = new DiscoveryService(ossConfig);
    project = await discoveryService.getProjectInfo(repo);

    if (!project) {
      logger.error(`Could not find repository: ${repo}`);
      process.exit(1);
    }
  } else {
    // Try to detect from current directory
    logger.error("No repository specified. Usage: oss-agent suggest <owner/repo>");
    logger.info("Example: oss-agent suggest python-poetry/poetry");
    process.exit(1);
  }

  const selectionService = new SelectionService(ossConfig);

  if (!options.json) {
    logger.info(`Repository: ${pc.cyan(project.fullName)}`);
    if (options.labels && options.labels.length > 0) {
      logger.info(`Filter labels: ${pc.cyan(options.labels.join(", "))}`);
    }
    // Show active filters
    const filters: string[] = [];
    if (!options.includeClosed) filters.push("open issues only");
    if (!options.includeAssigned) filters.push("unassigned only");
    if (options.prFilter) filters.push("no existing PRs");
    if (filters.length > 0) {
      logger.info(`Filters: ${pc.dim(filters.join(", "))}`);
    }
    console.error("");
    logger.info("Finding issues...");
  }

  const issues = await selectionService.findIssues(project, {
    filterLabels: options.labels,
    excludeLabels: options.excludeLabels,
    requireNoExistingPR: options.prFilter,
    includeAssigned: options.includeAssigned,
    state: options.includeClosed ? "all" : "open",
    limit: options.limit * 2, // Get more to allow for PR filtering
  });

  // Take only what we need
  const limitedIssues = issues.slice(0, options.limit);

  if (options.json) {
    // JSON output
    if (options.score) {
      const scored = limitedIssues.map((issue) => ({
        ...issue,
        score: selectionService.scoreIssue(issue),
      }));
      console.log(JSON.stringify(scored, null, 2));
    } else {
      console.log(JSON.stringify(limitedIssues, null, 2));
    }
    return;
  }

  // Pretty output
  console.error("");
  logger.success(`Found ${limitedIssues.length} issues`);
  console.error("");

  if (limitedIssues.length === 0) {
    logger.info("No issues matched your criteria. Try adjusting filters.");
    logger.info(
      "Hint: Use --labels to filter by specific labels, or --no-pr-filter to include issues with PRs"
    );
    return;
  }

  for (const issue of limitedIssues) {
    displayIssue(issue, selectionService, options.score, options.roi, project);
  }

  // Summary
  console.error("");
  console.error(pc.dim("─".repeat(60)));
  console.error("");
  console.error(pc.dim(`Showing ${limitedIssues.length} issues`));
  console.error(
    pc.dim(`To work on an issue: oss-agent work ${limitedIssues[0]?.url ?? "<issue-url>"}`)
  );
}

function displayIssue(
  issue: GitHubIssueInfo,
  selectionService: SelectionService,
  showScore: boolean,
  showROI: boolean,
  project?: Project
): void {
  console.error(pc.dim("─".repeat(60)));
  console.error("");

  // Title line with issue number
  const numberStr = pc.yellow(`#${issue.number}`);
  console.error(`${numberStr}  ${pc.bold(issue.title)}`);

  // Body preview
  if (issue.body) {
    const preview = issue.body.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim().substring(0, 120);
    console.error(pc.dim(preview + (issue.body.length > 120 ? "..." : "")));
  }

  // Labels
  if (issue.labels.length > 0) {
    const labelsStr = issue.labels
      .map((l) => {
        // Color code certain labels
        if (l.toLowerCase().includes("good first") || l.toLowerCase().includes("beginner")) {
          return pc.green(l);
        }
        if (l.toLowerCase().includes("help wanted")) {
          return pc.blue(l);
        }
        if (l.toLowerCase().includes("bug")) {
          return pc.red(l);
        }
        if (l.toLowerCase().includes("enhancement") || l.toLowerCase().includes("feature")) {
          return pc.cyan(l);
        }
        return pc.magenta(l);
      })
      .join(" ");
    console.error(`Labels: ${labelsStr}`);
  }

  // Metadata line
  const meta: string[] = [];
  const daysAgo = Math.floor((Date.now() - issue.createdAt.getTime()) / (1000 * 60 * 60 * 24));
  const ageStr = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo}d ago`;
  meta.push(`Created ${ageStr}`);
  meta.push(`${issue.comments.length} comments`);
  if (issue.assignees.length > 0) {
    meta.push(pc.yellow(`Assigned: ${issue.assignees.join(", ")}`));
  }
  console.error(pc.dim(meta.join(" • ")));

  // ROI analysis (if requested)
  if (showROI) {
    const roi = selectionService.calculateROI(
      issue,
      project
        ? {
            stars: project.stars,
            forks: project.forks,
          }
        : undefined
    );
    const f = roi.feasibility;
    const i = roi.impact;
    const c = roi.cost;

    // Color code the ROI score
    let roiColor: (s: string) => string;
    if (roi.roi >= 70) {
      roiColor = pc.green;
    } else if (roi.roi >= 40) {
      roiColor = pc.yellow;
    } else {
      roiColor = pc.red;
    }

    console.error(
      pc.dim(`ROI: `) +
        pc.bold(roiColor(roi.roi.toString())) +
        pc.dim(` = √(F:${f.total}×I:${i.total}) × (100-C:${c.total})%`)
    );
    console.error(
      pc.dim(
        `  Feasibility: clarity:${f.clarity} scope:${f.scope} action:${f.actionability} guide:${f.guidance}`
      )
    );
    console.error(
      pc.dim(
        `  Impact: repo:${i.repoPopularity} labels:${i.labelImportance} fresh:${i.freshness} interest:${i.communityInterest}`
      )
    );
    console.error(
      pc.dim(
        `  Cost: scope:${c.estimatedScope} complexity:${c.complexitySignals} risk:${c.riskLabels} contention:${c.contention}`
      )
    );
  }

  // Legacy score (if requested)
  if (showScore) {
    const score = selectionService.scoreIssue(issue);
    const b = score.breakdown;
    console.error(
      pc.dim(`Score: `) +
        pc.bold(pc.green(score.total.toString())) +
        pc.dim(
          ` (desc:${b.complexity} eng:${b.engagement} age:${b.recency} lbl:${b.labels} title:${b.clarity} scope:${b.codeScope} action:${b.actionability})`
        )
    );
  }

  // URL
  console.error(pc.dim(issue.url));
  console.error("");
}
