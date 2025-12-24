import { Command } from "commander";
import { logger } from "../../infra/logger.js";
import { WebhookHandler } from "../../core/engine/webhook-handler.js";

export function createWebhookCommand(): Command {
  const command = new Command("webhook")
    .description("Start a webhook server to receive GitHub PR events")
    .option("-p, --port <port>", "Port to listen on", (v) => parseInt(v, 10), 3000)
    .option("-s, --secret <secret>", "GitHub webhook secret for signature verification")
    .option("--repos <repos>", "Comma-separated list of allowed repositories (owner/repo)")
    .option("--no-auto-iterate", "Don't automatically trigger iterate on feedback")
    .option("--delete-branch-on-merge", "Delete source branch when PR is merged", false)
    .option("-v, --verbose", "Enable verbose output", false)
    .action(async (options: WebhookOptions) => {
      if (options.verbose) {
        logger.configure({ level: "debug", verbose: true });
      }

      try {
        await runWebhook(options);
      } catch (error) {
        logger.error("Webhook server failed", error);
        process.exit(1);
      }
    });

  return command;
}

interface WebhookOptions {
  port: number;
  secret?: string;
  repos?: string;
  autoIterate: boolean;
  deleteBranchOnMerge: boolean;
  verbose: boolean;
}

async function runWebhook(options: WebhookOptions): Promise<void> {
  logger.header("OSS Agent - Webhook Server");

  // Support environment variables as fallback for Render/Docker deployment
  const port = options.port ?? parseInt(process.env.PORT ?? "3000", 10);
  const secret = options.secret ?? process.env.WEBHOOK_SECRET;
  const reposEnv = options.repos ?? process.env.ALLOWED_REPOS;
  const autoIterate = options.autoIterate && process.env.AUTO_ITERATE !== "false";
  const deleteBranchOnMerge =
    options.deleteBranchOnMerge || process.env.DELETE_BRANCH_ON_MERGE === "true";

  logger.info(`Port: ${port}`);
  if (secret) {
    logger.info("Secret: configured");
  } else {
    logger.warn("No secret configured - webhook signatures will not be verified");
  }
  logger.info(`Auto-iterate: ${autoIterate ? "enabled" : "disabled"}`);
  logger.info(`Delete branch on merge: ${deleteBranchOnMerge ? "enabled" : "disabled"}`);

  const allowedRepos = reposEnv ? reposEnv.split(",").map((r) => r.trim()) : undefined;

  if (allowedRepos) {
    logger.info(`Allowed repos: ${allowedRepos.join(", ")}`);
  }

  console.error("");

  const handler = new WebhookHandler({
    port,
    secret,
    allowedRepos,
    autoIterate,
    deleteBranchOnMerge,
  });

  // Handle shutdown
  process.on("SIGINT", async () => {
    logger.info("\nShutting down...");
    await handler.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await handler.stop();
    process.exit(0);
  });

  // Start server
  await handler.start();

  logger.info("");
  logger.info("Webhook endpoints:");
  logger.info(`  POST http://localhost:${port}/`);
  logger.info(`  POST http://localhost:${port}/webhook`);
  logger.info(`  GET  http://localhost:${port}/health`);
  logger.info("");
  logger.info("Press Ctrl+C to stop");

  // Keep running
  await new Promise(() => {});
}
