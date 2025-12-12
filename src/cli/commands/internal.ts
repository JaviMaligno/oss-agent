/**
 * Internal CLI commands for hook scripts
 *
 * These commands are hidden from --help and are meant to be called
 * by Claude Code hook scripts, not directly by users.
 */

import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { loadConfig, expandPath } from "../config/loader.js";
import { StateManager } from "../../core/state/state-manager.js";
import { PRService } from "../../core/github/pr-service.js";
import { FeedbackParser } from "../../core/github/feedback-parser.js";
import { logger } from "../../infra/logger.js";

/**
 * Create the internal command group (hidden from help)
 */
export function createInternalCommand(): Command {
  // Note: Use .helpCommand(false) since .hidden() doesn't exist in Commander.js
  const command = new Command("internal").description(
    "Internal commands for hooks (not for direct use)"
  );

  command.addCommand(createGetSessionContextCommand());
  command.addCommand(createCheckPrCreatedCommand());
  command.addCommand(createSaveSessionStateCommand());
  command.addCommand(createRegisterPrCommand());

  return command;
}

/**
 * Get session context for injecting into Claude Code sessions
 */
function createGetSessionContextCommand(): Command {
  return new Command("get-session-context")
    .description("Get context for the current session (for hooks)")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const config = loadConfig();
        const stateManager = new StateManager(expandPath(config.dataDir));

        // Find active sessions with PRs
        const activeSessions = stateManager.getActiveSessions();
        const sessionsWithPRs = activeSessions.filter((s) => s.prUrl);

        if (sessionsWithPRs.length === 0) {
          if (options.json) {
            console.log(JSON.stringify({ hasContext: false }));
          }
          process.exit(0);
        }

        // Get the most recent session with a PR
        const session = sessionsWithPRs[0];
        if (!session?.prUrl) {
          if (options.json) {
            console.log(JSON.stringify({ hasContext: false }));
          }
          process.exit(0);
        }

        // Fetch PR feedback
        const prService = new PRService();
        const feedbackParser = new FeedbackParser();

        try {
          // Parse PR URL to get owner, repo, prNumber
          const parsed = prService.parsePRUrl(session.prUrl);
          if (!parsed) {
            if (options.json) {
              console.log(JSON.stringify({ hasContext: false, error: "Invalid PR URL" }));
            }
            process.exit(0);
          }

          const feedback = await prService.getPRFeedback(
            parsed.owner,
            parsed.repo,
            parsed.prNumber
          );
          const parsedFeedback = feedbackParser.parse(
            feedback.pr,
            feedback.reviews,
            feedback.comments,
            feedback.checks
          );

          if (parsedFeedback.actionableItems.length === 0) {
            if (options.json) {
              console.log(JSON.stringify({ hasContext: false }));
            }
            process.exit(0);
          }

          // Format context for injection
          const context = feedbackParser.formatForPrompt(parsedFeedback.actionableItems);

          if (options.json) {
            console.log(
              JSON.stringify({
                hasContext: true,
                sessionId: session.id,
                issueUrl: session.issueUrl,
                prUrl: session.prUrl,
                feedbackCount: parsedFeedback.actionableItems.length,
                context,
              })
            );
          } else {
            // Output context directly for shell scripts
            console.log(context);
          }
        } catch (error) {
          logger.debug(`Failed to fetch PR feedback: ${error}`);
          if (options.json) {
            console.log(JSON.stringify({ hasContext: false, error: String(error) }));
          }
          process.exit(0);
        }

        stateManager.close();
      } catch (error) {
        logger.error(`get-session-context failed: ${error}`);
        process.exit(1);
      }
    });
}

/**
 * Check if a PR was created by scanning a transcript
 */
function createCheckPrCreatedCommand(): Command {
  return new Command("check-pr-created")
    .description("Scan transcript for PR creation (for hooks)")
    .requiredOption("--transcript <path>", "Path to transcript JSONL file")
    .action(async (options) => {
      try {
        const transcriptPath = options.transcript as string;

        if (!existsSync(transcriptPath)) {
          logger.debug(`Transcript file not found: ${transcriptPath}`);
          process.exit(0);
        }

        const content = readFileSync(transcriptPath, "utf-8");
        const lines = content.split("\n").filter((line) => line.trim());

        // Look for PR URLs in the transcript
        const prUrlPattern = /https:\/\/github\.com\/[\w-]+\/[\w-]+\/pull\/\d+/g;
        const prUrls = new Set<string>();

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as { content?: string; text?: string };
            const text = entry.content ?? entry.text ?? "";
            const matches = text.match(prUrlPattern);
            if (matches) {
              for (const match of matches) {
                prUrls.add(match);
              }
            }
          } catch {
            // Skip malformed lines
          }
        }

        if (prUrls.size === 0) {
          logger.debug("No PR URLs found in transcript");
          process.exit(0);
        }

        // Register the PR(s) for monitoring
        const config = loadConfig();
        const stateManager = new StateManager(expandPath(config.dataDir));
        const prService = new PRService();

        for (const prUrl of prUrls) {
          try {
            const parsed = prService.parsePRUrl(prUrl);
            if (parsed) {
              // Check if already registered
              const existing = stateManager.getMonitoredPR(prUrl);
              if (!existing) {
                stateManager.registerMonitoredPR({
                  prUrl,
                  owner: parsed.owner,
                  repo: parsed.repo,
                  prNumber: parsed.prNumber,
                });
                logger.info(`Registered PR for monitoring: ${prUrl}`);
              }
            }
          } catch (error) {
            logger.debug(`Failed to register PR ${prUrl}: ${error}`);
          }
        }

        stateManager.close();
        console.log(JSON.stringify({ registered: Array.from(prUrls) }));
      } catch (error) {
        logger.error(`check-pr-created failed: ${error}`);
        process.exit(1);
      }
    });
}

/**
 * Save session state for potential resume
 */
function createSaveSessionStateCommand(): Command {
  return new Command("save-session-state")
    .description("Save session state (for hooks)")
    .requiredOption("--session-id <id>", "Session ID")
    .option("--transcript <path>", "Path to transcript file")
    .action(async (options) => {
      try {
        const config = loadConfig();
        const stateManager = new StateManager(expandPath(config.dataDir));

        const sessionId = options.sessionId as string;
        const session = stateManager.getSession(sessionId);

        if (!session) {
          logger.debug(`Session not found: ${sessionId}`);
          process.exit(0);
        }

        // Mark session as resumable
        stateManager.updateSessionMetrics(sessionId, {});
        logger.debug(`Session state saved: ${sessionId}`);

        stateManager.close();
        console.log(JSON.stringify({ saved: true, sessionId }));
      } catch (error) {
        logger.error(`save-session-state failed: ${error}`);
        process.exit(1);
      }
    });
}

/**
 * Register a PR for monitoring
 */
function createRegisterPrCommand(): Command {
  return new Command("register-pr")
    .description("Register a PR for monitoring (for hooks)")
    .requiredOption("--url <url>", "PR URL")
    .option("--issue-id <id>", "Associated issue ID")
    .option("--session-id <id>", "Associated session ID")
    .action(async (options) => {
      try {
        const config = loadConfig();
        const stateManager = new StateManager(expandPath(config.dataDir));
        const prService = new PRService();

        const prUrl = options.url as string;
        const parsed = prService.parsePRUrl(prUrl);

        if (!parsed) {
          logger.error(`Invalid PR URL: ${prUrl}`);
          process.exit(1);
        }

        const registerData: {
          prUrl: string;
          owner: string;
          repo: string;
          prNumber: number;
          issueId?: string;
          sessionId?: string;
        } = {
          prUrl,
          owner: parsed.owner,
          repo: parsed.repo,
          prNumber: parsed.prNumber,
        };
        if (options.issueId) {
          registerData.issueId = options.issueId as string;
        }
        if (options.sessionId) {
          registerData.sessionId = options.sessionId as string;
        }
        const monitoredPR = stateManager.registerMonitoredPR(registerData);

        stateManager.close();

        console.log(
          JSON.stringify({
            registered: true,
            prUrl: monitoredPR.prUrl,
            owner: monitoredPR.owner,
            repo: monitoredPR.repo,
            prNumber: monitoredPR.prNumber,
          })
        );
      } catch (error) {
        logger.error(`register-pr failed: ${error}`);
        process.exit(1);
      }
    });
}
