import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig } from "../config/loader.js";
import { createProvider } from "../../core/ai/index.js";
import {
  DiscoveryService,
  getValidDomains,
  getValidFrameworks,
  getCuratedListCategories,
  getSuggestedQueries,
} from "../../oss/discovery/index.js";
import type { Project } from "../../types/project.js";

export function createDiscoverCommand(): Command {
  const validDomains = getValidDomains();
  const validFrameworks = getValidFrameworks();
  const curatedCategories = getCuratedListCategories();

  const command = new Command("discover")
    .description("Find OSS projects to contribute to")
    .option("-m, --mode <mode>", "Discovery mode: direct, search, intelligent, curated", "search")
    .option("-l, --language <lang>", "Filter by programming language")
    .option("-t, --topic <topics...>", "Filter by topics (can specify multiple)")
    .option("-d, --domain <domain>", `Filter by domain: ${validDomains.join(", ")}`)
    .option(
      "-f, --framework <framework>",
      `Filter by framework: ${validFrameworks.slice(0, 8).join(", ")}...`
    )
    .option(
      "-c, --curated <list>",
      `Curated list: repo (e.g., vinta/awesome-python) or category: ${curatedCategories.slice(0, 5).join(", ")}...`
    )
    .option("-i, --intelligent", "Use AI-powered intelligent discovery (requires --query)")
    .option(
      "-q, --query <query>",
      'Natural language query for intelligent mode (e.g., "Python security tools for API testing")'
    )
    .option("--min-stars <n>", "Minimum stars", parseInt)
    .option("--max-stars <n>", "Maximum stars", parseInt)
    .option("-n, --limit <n>", "Maximum number of projects to return", parseInt, 20)
    .option("-r, --repos <repos...>", "Explicit repos for direct mode (owner/repo)")
    .option("--score", "Show project scores", false)
    .option("--json", "Output as JSON", false)
    .option("-v, --verbose", "Enable verbose output", false)
    .action(async (options: DiscoverOptions) => {
      if (options.verbose) {
        logger.configure({ level: "debug", verbose: true });
      }

      try {
        await runDiscover(options);
      } catch (error) {
        logger.error("Discovery failed", error);
        process.exit(1);
      }
    });

  return command;
}

interface DiscoverOptions {
  mode: "direct" | "search" | "intelligent" | "curated";
  language?: string | undefined;
  topic?: string[] | undefined;
  domain?: string | undefined;
  framework?: string | undefined;
  curated?: string | undefined;
  intelligent?: boolean | undefined;
  query?: string | undefined;
  minStars?: number | undefined;
  maxStars?: number | undefined;
  limit: number;
  repos?: string[] | undefined;
  score: boolean;
  json: boolean;
  verbose: boolean;
}

async function runDiscover(options: DiscoverOptions): Promise<void> {
  if (!options.json) {
    logger.header("OSS Agent - Discover Projects");
  }

  const config = loadConfig();
  const ossConfig = config.oss;

  // Auto-detect mode from options
  let effectiveMode = options.mode;
  if (options.curated) {
    effectiveMode = "curated";
  }
  if (options.intelligent || options.query) {
    effectiveMode = "intelligent";
  }

  // Validate options
  if (effectiveMode === "direct" && (!options.repos || options.repos.length === 0)) {
    // Use config directRepos if not specified
    const configRepos = ossConfig?.directRepos;
    if (!configRepos || configRepos.length === 0) {
      logger.error("Direct mode requires --repos or directRepos in config");
      process.exit(1);
    }
    options.repos = configRepos;
  }

  if (effectiveMode === "curated" && !options.curated) {
    logger.error("Curated mode requires --curated <list> option");
    logger.info("Example: oss-agent discover --curated python");
    logger.info("Example: oss-agent discover --curated vinta/awesome-python");
    process.exit(1);
  }

  if (effectiveMode === "intelligent" && !options.query) {
    logger.error("Intelligent mode requires --query option");
    logger.info(
      'Example: oss-agent discover --intelligent --query "Python security tools for API testing"'
    );
    logger.info("");
    logger.info("Suggested queries:");
    for (const suggestion of getSuggestedQueries(options.domain)) {
      logger.info(`  • ${suggestion}`);
    }
    process.exit(1);
  }

  const discoveryService = new DiscoveryService(ossConfig);

  // Set up AI provider for intelligent mode
  if (effectiveMode === "intelligent") {
    try {
      const aiProvider = await createProvider(config);
      discoveryService.setAIProvider(aiProvider);
      if (!options.json) {
        logger.info(`AI provider: ${pc.cyan(aiProvider.name)}`);
      }
    } catch (error) {
      logger.warn(`Failed to initialize AI provider: ${error}`);
      logger.info("Falling back to scored search");
    }
  }

  if (!options.json) {
    logger.info(`Mode: ${pc.cyan(effectiveMode)}`);
    if (options.query) {
      logger.info(`Query: ${pc.cyan(options.query)}`);
    }
    if (options.curated) {
      logger.info(`Curated list: ${pc.cyan(options.curated)}`);
    }
    if (options.language) {
      logger.info(`Language: ${pc.cyan(options.language)}`);
    }
    if (options.domain) {
      logger.info(`Domain: ${pc.cyan(options.domain)}`);
    }
    if (options.framework) {
      logger.info(`Framework: ${pc.cyan(options.framework)}`);
    }
    if (options.topic && options.topic.length > 0) {
      logger.info(`Topics: ${pc.cyan(options.topic.join(", "))}`);
    }
    if (options.minStars !== undefined || options.maxStars !== undefined) {
      const range = `${options.minStars ?? 0} - ${options.maxStars ?? "∞"}`;
      logger.info(`Stars: ${pc.cyan(range)}`);
    }
    console.error("");
    if (effectiveMode === "intelligent") {
      logger.info("Running AI-powered search (this may take a minute)...");
    } else {
      logger.info("Searching for projects...");
    }
  }

  const projects = await discoveryService.discover({
    mode: effectiveMode,
    directRepos: options.repos,
    language: options.language,
    domain: options.domain,
    framework: options.framework,
    curatedList: options.curated,
    intelligentQuery: options.query,
    minStars: options.minStars ?? ossConfig?.minStars,
    maxStars: options.maxStars ?? ossConfig?.maxStars,
    topics: options.topic,
  });

  // Limit results
  const limitedProjects = projects.slice(0, options.limit);

  if (options.json) {
    // JSON output
    if (options.score) {
      const scored = await Promise.all(
        limitedProjects.map(async (p) => ({
          ...p,
          score: await discoveryService.scoreProject(p),
        }))
      );
      console.log(JSON.stringify(scored, null, 2));
    } else {
      console.log(JSON.stringify(limitedProjects, null, 2));
    }
    return;
  }

  // Pretty output
  console.error("");
  logger.success(`Found ${limitedProjects.length} projects`);
  console.error("");

  if (limitedProjects.length === 0) {
    logger.info("No projects matched your criteria. Try adjusting filters.");
    return;
  }

  for (const project of limitedProjects) {
    await displayProject(project, discoveryService, options.score);
  }

  // Summary
  console.error("");
  console.error(pc.dim("─".repeat(60)));
  console.error("");
  console.error(pc.dim(`Showing ${limitedProjects.length} of ${projects.length} projects`));
  console.error(pc.dim(`Use --limit to see more, or --json for machine-readable output`));
}

async function displayProject(
  project: Project,
  discoveryService: DiscoveryService,
  showScore: boolean
): Promise<void> {
  console.error(pc.dim("─".repeat(60)));
  console.error("");

  // Title line with stars
  const starsStr = pc.yellow(`★ ${formatNumber(project.stars)}`);
  console.error(`${pc.bold(pc.cyan(project.fullName))}  ${starsStr}`);

  // Description
  if (project.description) {
    const desc =
      project.description.length > 80
        ? project.description.substring(0, 77) + "..."
        : project.description;
    console.error(pc.dim(desc));
  }

  // Metadata line
  const meta: string[] = [];
  if (project.language) {
    meta.push(pc.blue(project.language));
  }
  if (project.license) {
    meta.push(pc.green(project.license));
  }
  meta.push(`${project.openIssues} open issues`);
  meta.push(`${project.forks} forks`);
  console.error(meta.join(pc.dim(" • ")));

  // Topics
  if (project.topics.length > 0) {
    const topicsStr = project.topics
      .slice(0, 5)
      .map((t) => pc.magenta(t))
      .join(" ");
    console.error(`Topics: ${topicsStr}`);
  }

  // Activity
  const daysAgo = Math.floor(
    (Date.now() - project.lastActivityAt.getTime()) / (1000 * 60 * 60 * 24)
  );
  const activityStr = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
  console.error(pc.dim(`Last activity: ${activityStr}`));

  // Score (if requested)
  if (showScore) {
    const score = await discoveryService.scoreProject(project);
    console.error(
      pc.dim(`Score: `) +
        pc.bold(pc.green(score.total.toString())) +
        pc.dim(
          ` (response: ${score.breakdown.responseTime}, community: ${score.breakdown.communityHealth}, docs: ${score.breakdown.documentationQuality})`
        )
    );
  }

  // URL
  console.error(pc.dim(project.url));
  console.error("");
}

function formatNumber(n: number): string {
  if (n >= 1000000) {
    return (n / 1000000).toFixed(1) + "M";
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + "k";
  }
  return n.toString();
}
