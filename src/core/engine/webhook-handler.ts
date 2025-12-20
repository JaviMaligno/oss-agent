/**
 * Webhook Handler - Receives GitHub webhook events for PR feedback
 *
 * Starts an HTTP server that listens for GitHub webhook events and
 * triggers the iterate command when PR review feedback is received.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { logger } from "../../infra/logger.js";

export interface WebhookConfig {
  port: number;
  secret?: string | undefined;
  allowedRepos?: string[] | undefined;
  autoIterate?: boolean | undefined;
}

export interface WebhookEvent {
  action: string;
  pullRequest: {
    number: number;
    htmlUrl: string;
    state: string;
    draft: boolean;
    headRef: string;
    baseRef: string;
  };
  repository: {
    fullName: string;
  };
  sender: {
    login: string;
  };
  review?: {
    id: number;
    state: string;
    body: string | null;
    user: { login: string };
  };
  comment?: {
    id: number;
    body: string;
    user: { login: string };
  };
}

export class WebhookHandler {
  private config: WebhookConfig;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  /**
   * Start the webhook server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on("error", (error) => {
        logger.error(`Webhook server error: ${error.message}`);
        reject(error);
      });

      this.server.listen(this.config.port, () => {
        logger.success(`Webhook server listening on port ${this.config.port}`);
        logger.info("Configure GitHub webhook to POST to this URL");
        logger.info("Events to subscribe: pull_request_review, pull_request_review_comment");
        resolve();
      });
    });
  }

  /**
   * Stop the webhook server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info("Webhook server stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle incoming HTTP request
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Method Not Allowed");
      return;
    }

    if (req.url !== "/" && req.url !== "/webhook") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    let body = "";

    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      this.processWebhook(req, body, res);
    });
  }

  /**
   * Process a webhook payload
   */
  private processWebhook(req: IncomingMessage, body: string, res: ServerResponse): void {
    // Verify signature if secret is configured
    if (this.config.secret) {
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!signature || !this.verifySignature(body, signature)) {
        logger.warn("Webhook signature verification failed");
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
    }

    // Parse event type
    const eventType = req.headers["x-github-event"] as string | undefined;
    if (!eventType) {
      res.writeHead(400);
      res.end("Missing event type");
      return;
    }

    // Parse payload
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }

    // Handle the event
    const handled = this.handleEvent(eventType, payload);

    if (handled) {
      res.writeHead(200);
      res.end("OK");
    } else {
      res.writeHead(200);
      res.end("Ignored");
    }
  }

  /**
   * Verify GitHub webhook signature
   */
  private verifySignature(payload: string, signature: string): boolean {
    if (!this.config.secret) return true;

    const hmac = createHmac("sha256", this.config.secret);
    hmac.update(payload);
    const expected = `sha256=${hmac.digest("hex")}`;

    return signature === expected;
  }

  /**
   * Handle a GitHub event
   */
  private handleEvent(eventType: string, payload: Record<string, unknown>): boolean {
    // Extract PR info based on event type
    let prUrl: string | null = null;
    let eventDescription = "";

    if (eventType === "pull_request_review") {
      const pr = payload.pull_request as { html_url?: string } | undefined;
      const review = payload.review as { state?: string; user?: { login?: string } } | undefined;
      const action = payload.action as string | undefined;

      if (pr?.html_url && action === "submitted") {
        prUrl = pr.html_url;
        eventDescription = `Review ${review?.state} by ${review?.user?.login}`;
      }
    } else if (eventType === "pull_request_review_comment") {
      const pr = payload.pull_request as { html_url?: string } | undefined;
      const comment = payload.comment as { user?: { login?: string } } | undefined;
      const action = payload.action as string | undefined;

      if (pr?.html_url && action === "created") {
        prUrl = pr.html_url;
        eventDescription = `Review comment by ${comment?.user?.login}`;
      }
    } else if (eventType === "issue_comment") {
      // Issue comments on PRs
      const issue = payload.issue as { pull_request?: unknown; html_url?: string } | undefined;
      const comment = payload.comment as { user?: { login?: string } } | undefined;
      const action = payload.action as string | undefined;

      if (issue?.pull_request && action === "created") {
        // Convert issue URL to PR URL
        prUrl = issue.html_url?.replace("/issues/", "/pull/") ?? null;
        eventDescription = `Comment by ${comment?.user?.login}`;
      }
    }

    if (!prUrl) {
      logger.debug(`Ignoring event: ${eventType}`);
      return false;
    }

    // Check if repo is allowed
    const repo = payload.repository as { full_name?: string } | undefined;
    if (
      this.config.allowedRepos &&
      this.config.allowedRepos.length > 0 &&
      repo?.full_name &&
      !this.config.allowedRepos.includes(repo.full_name)
    ) {
      logger.debug(`Ignoring event from non-allowed repo: ${repo.full_name}`);
      return false;
    }

    logger.info(`Received webhook: ${eventDescription}`);
    logger.info(`PR: ${prUrl}`);

    // Trigger iterate if auto-iterate is enabled
    if (this.config.autoIterate !== false) {
      this.triggerIterate(prUrl);
    }

    return true;
  }

  /**
   * Trigger the iterate command for a PR
   */
  private triggerIterate(prUrl: string): void {
    logger.info(`Triggering iterate for: ${prUrl}`);

    const proc = spawn("node", ["dist/cli/index.js", "iterate", prUrl, "--verbose"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    proc.stdout?.on("data", (data: Buffer) => {
      logger.debug(`[iterate] ${data.toString().trim()}`);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      logger.debug(`[iterate] ${data.toString().trim()}`);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        logger.success(`Iterate completed for: ${prUrl}`);
      } else {
        logger.warn(`Iterate exited with code ${code} for: ${prUrl}`);
      }
    });

    proc.unref();
  }
}
