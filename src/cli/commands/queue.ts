import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig } from "../config/loader.js";
import { StateManager } from "../../core/state/index.js";
import { SelectionService } from "../../oss/selection/index.js";
import { DiscoveryService } from "../../oss/discovery/index.js";
import type { Issue, IssueState } from "../../types/issue.js";

export function createQueueCommand(): Command {
  const command = new Command("queue")
    .description("Manage the issue work queue")
    .addCommand(createListSubcommand())
    .addCommand(createAddSubcommand())
    .addCommand(createSkipSubcommand())
    .addCommand(createPrioritizeSubcommand())
    .addCommand(createClearSubcommand());

  return command;
}

function createListSubcommand(): Command {
  return new Command("list")
    .description("List issues in the queue")
    .option(
      "-s, --state <state>",
      "Filter by state: queued, in_progress, pr_created, awaiting_feedback, etc."
    )
    .option("--all", "Show all issues regardless of state")
    .option("-p, --project <project>", "Filter by project (owner/repo)")
    .option("-n, --limit <n>", "Maximum number to show", parseInt, 20)
    .option("--json", "Output as JSON")
    .action(async (options: ListOptions) => {
      try {
        await runList(options);
      } catch (error) {
        logger.error("List failed", error);
        process.exit(1);
      }
    });
}

function createAddSubcommand(): Command {
  return new Command("add")
    .description("Add an issue to the queue")
    .argument("<url>", "Issue URL (e.g., https://github.com/owner/repo/issues/123)")
    .option("--priority", "Add to front of queue", false)
    .action(async (url: string, options: AddOptions) => {
      try {
        await runAdd(url, options);
      } catch (error) {
        logger.error("Add failed", error);
        process.exit(1);
      }
    });
}

function createSkipSubcommand(): Command {
  return new Command("skip")
    .description("Skip an issue (mark as abandoned)")
    .argument("<id>", "Issue ID or URL")
    .option("-r, --reason <reason>", "Reason for skipping", "Manually skipped")
    .action(async (id: string, options: SkipOptions) => {
      try {
        await runSkip(id, options);
      } catch (error) {
        logger.error("Skip failed", error);
        process.exit(1);
      }
    });
}

function createPrioritizeSubcommand(): Command {
  return new Command("prioritize")
    .description("Move an issue to the front of the queue")
    .argument("<id>", "Issue ID or URL")
    .action(async (id: string) => {
      try {
        await runPrioritize(id);
      } catch (error) {
        logger.error("Prioritize failed", error);
        process.exit(1);
      }
    });
}

function createClearSubcommand(): Command {
  return new Command("clear")
    .description("Clear all issues from the queue")
    .option("-s, --state <state>", "Only clear issues in specific state")
    .option("--force", "Skip confirmation", false)
    .action(async (options: ClearOptions) => {
      try {
        await runClear(options);
      } catch (error) {
        logger.error("Clear failed", error);
        process.exit(1);
      }
    });
}

// Options interfaces
interface ListOptions {
  state?: string | undefined;
  all: boolean;
  project?: string | undefined;
  limit: number;
  json: boolean;
}

interface AddOptions {
  priority: boolean;
}

interface SkipOptions {
  reason: string;
}

interface ClearOptions {
  state?: string | undefined;
  force: boolean;
}

// Command implementations
async function runList(options: ListOptions): Promise<void> {
  const config = loadConfig();
  const dataDir = config.dataDir ?? `${process.env.HOME ?? "."}/.oss-agent`;
  const stateManager = new StateManager(dataDir);

  try {
    let issues: Issue[] = [];

    if (options.all) {
      // Get all issues by combining different states
      const states: IssueState[] = [
        "discovered",
        "queued",
        "in_progress",
        "pr_created",
        "awaiting_feedback",
        "iterating",
      ];
      for (const state of states) {
        issues.push(...stateManager.getIssuesByState(state));
      }
    } else if (options.state) {
      issues = stateManager.getIssuesByState(options.state as IssueState);
    } else {
      // Default: show queued issues
      issues = stateManager.getIssuesByState("queued");
    }

    // Filter by project
    if (options.project) {
      issues = issues.filter(
        (i) => i.projectId === options.project || i.projectId.includes(options.project ?? "")
      );
    }

    // Limit results
    issues = issues.slice(0, options.limit);

    if (options.json) {
      console.log(JSON.stringify(issues, null, 2));
      return;
    }

    // Pretty output
    logger.header("Issue Queue");

    if (issues.length === 0) {
      logger.info("No issues in queue.");
      logger.info("Add issues with: oss-agent queue add <issue-url>");
      return;
    }

    const stateColors: Record<string, (s: string) => string> = {
      discovered: pc.dim,
      queued: pc.yellow,
      in_progress: pc.blue,
      pr_created: pc.cyan,
      awaiting_feedback: pc.magenta,
      iterating: pc.blue,
      merged: pc.green,
      closed: pc.gray,
      abandoned: pc.red,
    };

    for (const issue of issues) {
      console.error("");
      console.error(pc.dim("─".repeat(60)));

      // Issue header
      const stateColor = stateColors[issue.state] ?? pc.white;
      console.error(`${pc.yellow(`#${issue.number}`)} ${pc.bold(issue.title)}`);
      console.error(
        `${pc.dim("Project:")} ${pc.cyan(issue.projectId)} ${pc.dim("State:")} ${stateColor(issue.state)}`
      );

      // Labels
      if (issue.labels.length > 0) {
        const labelsStr = issue.labels
          .slice(0, 5)
          .map((l) => pc.magenta(l))
          .join(" ");
        console.error(`${pc.dim("Labels:")} ${labelsStr}`);
      }

      // Metadata
      const daysAgo = Math.floor((Date.now() - issue.updatedAt.getTime()) / (1000 * 60 * 60 * 24));
      const ageStr = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo}d ago`;
      console.error(pc.dim(`Updated: ${ageStr}`));

      // URL
      console.error(pc.dim(issue.url));
    }

    console.error("");
    console.error(pc.dim("─".repeat(60)));
    console.error("");
    console.error(pc.dim(`Total: ${issues.length} issues`));
  } finally {
    stateManager.close();
  }
}

async function runAdd(url: string, options: AddOptions): Promise<void> {
  // Parse issue URL
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!match) {
    logger.error("Invalid issue URL format. Expected: https://github.com/owner/repo/issues/123");
    process.exit(1);
  }

  const [, owner, repo, numberStr] = match;
  const issueNumber = parseInt(numberStr ?? "0", 10);
  const projectId = `${owner}/${repo}`;

  const config = loadConfig();
  const dataDir = config.dataDir ?? `${process.env.HOME ?? "."}/.oss-agent`;
  const stateManager = new StateManager(dataDir);

  try {
    // Check if already in queue
    const existingIssue = stateManager.getIssueByUrl(url);
    if (existingIssue) {
      logger.info(`Issue already in queue with state: ${existingIssue.state}`);
      if (options.priority && existingIssue.state === "queued") {
        // Update timestamp to move to front
        const now = new Date();
        stateManager.saveIssue({
          ...existingIssue,
          updatedAt: now,
        });
        logger.success("Issue moved to front of queue");
      }
      return;
    }

    // Fetch issue details from GitHub
    logger.info(`Fetching issue details from GitHub...`);
    const discoveryService = new DiscoveryService(config.oss);
    const selectionService = new SelectionService(config.oss);

    // Get project info first
    const project = await discoveryService.getProjectInfo(projectId);
    if (!project) {
      logger.error(`Could not find project: ${projectId}`);
      process.exit(1);
    }

    // Find the specific issue
    const issues = await selectionService.findIssues(project, { limit: 100 });
    const ghIssue = issues.find((i) => i.number === issueNumber);

    if (!ghIssue) {
      // Create minimal issue record if not found in list
      logger.warn("Issue not found in project issue list, creating minimal record");
      const now = new Date();
      stateManager.saveIssue({
        id: `${projectId}#${issueNumber}`,
        url,
        number: issueNumber,
        title: `Issue #${issueNumber}`,
        body: "",
        labels: [],
        state: "queued",
        author: "",
        assignee: null,
        createdAt: now,
        updatedAt: now,
        projectId,
        hasLinkedPR: false,
        linkedPRUrl: null,
      });
    } else {
      // Create full issue record
      stateManager.saveIssue({
        id: ghIssue.id,
        url: ghIssue.url,
        number: ghIssue.number,
        title: ghIssue.title,
        body: ghIssue.body,
        labels: ghIssue.labels,
        state: "queued",
        author: ghIssue.author,
        assignee: ghIssue.assignees[0] ?? null,
        createdAt: ghIssue.createdAt,
        updatedAt: new Date(),
        projectId,
        hasLinkedPR: false,
        linkedPRUrl: null,
      });
    }

    logger.success(`Added issue to queue: ${projectId}#${issueNumber}`);
    if (options.priority) {
      logger.info("Issue added to front of queue");
    }
  } finally {
    stateManager.close();
  }
}

async function runSkip(id: string, options: SkipOptions): Promise<void> {
  const config = loadConfig();
  const dataDir = config.dataDir ?? `${process.env.HOME ?? "."}/.oss-agent`;
  const stateManager = new StateManager(dataDir);

  try {
    // Find issue by ID or URL
    let issue = stateManager.getIssue(id);
    issue ??= stateManager.getIssueByUrl(id);

    if (!issue) {
      logger.error(`Issue not found: ${id}`);
      process.exit(1);
    }

    // Can only skip from certain states
    const skippableStates: IssueState[] = ["discovered", "queued", "in_progress"];
    if (!skippableStates.includes(issue.state)) {
      logger.error(`Cannot skip issue in state: ${issue.state}`);
      logger.info(`Issue can be skipped from: ${skippableStates.join(", ")}`);
      process.exit(1);
    }

    stateManager.transitionIssue(issue.id, "abandoned", options.reason);
    logger.success(`Skipped issue: ${issue.projectId}#${issue.number}`);
    logger.info(`Reason: ${options.reason}`);
  } finally {
    stateManager.close();
  }
}

async function runPrioritize(id: string): Promise<void> {
  const config = loadConfig();
  const dataDir = config.dataDir ?? `${process.env.HOME ?? "."}/.oss-agent`;
  const stateManager = new StateManager(dataDir);

  try {
    // Find issue
    let issue = stateManager.getIssue(id);
    issue ??= stateManager.getIssueByUrl(id);

    if (!issue) {
      logger.error(`Issue not found: ${id}`);
      process.exit(1);
    }

    if (issue.state !== "queued") {
      logger.error(`Can only prioritize queued issues. Current state: ${issue.state}`);
      process.exit(1);
    }

    // Update timestamp to move to front (queries are sorted by updated_at DESC)
    stateManager.saveIssue({
      ...issue,
      updatedAt: new Date(),
    });

    logger.success(`Prioritized issue: ${issue.projectId}#${issue.number}`);
    logger.info("Issue moved to front of queue");
  } finally {
    stateManager.close();
  }
}

async function runClear(options: ClearOptions): Promise<void> {
  if (!options.force) {
    logger.warn("This will remove issues from the queue. Use --force to confirm.");
    return;
  }

  const config = loadConfig();
  const dataDir = config.dataDir ?? `${process.env.HOME ?? "."}/.oss-agent`;
  const stateManager = new StateManager(dataDir);

  try {
    let issues: Issue[] = [];

    if (options.state) {
      issues = stateManager.getIssuesByState(options.state as IssueState);
    } else {
      // Clear queued issues
      issues = stateManager.getIssuesByState("queued");
    }

    let cleared = 0;
    for (const issue of issues) {
      try {
        stateManager.transitionIssue(issue.id, "abandoned", "Cleared from queue");
        cleared++;
      } catch {
        // Ignore transition errors
      }
    }

    logger.success(`Cleared ${cleared} issues from queue`);
  } finally {
    stateManager.close();
  }
}
