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
  verbose: boolean;
}

async function runWebhook(options: WebhookOptions): Promise<void> {
  logger.header("OSS Agent - Webhook Server");

  logger.info(`Port: ${options.port}`);
  if (options.secret) {
    logger.info("Secret: configured");
  } else {
    logger.warn("No secret configured - webhook signatures will not be verified");
  }
  logger.info(`Auto-iterate: ${options.autoIterate ? "enabled" : "disabled"}`);

  const allowedRepos = options.repos ? options.repos.split(",").map((r) => r.trim()) : undefined;

  if (allowedRepos) {
    logger.info(`Allowed repos: ${allowedRepos.join(", ")}`);
  }

  console.error("");

  const handler = new WebhookHandler({
    port: options.port,
    secret: options.secret,
    allowedRepos,
    autoIterate: options.autoIterate,
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
  logger.info(`  POST http://localhost:${options.port}/`);
  logger.info(`  POST http://localhost:${options.port}/webhook`);
  logger.info("");
  logger.info("Press Ctrl+C to stop");

  // Keep running
  await new Promise(() => {});
}
