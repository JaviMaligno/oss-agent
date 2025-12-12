#!/usr/bin/env node

import { Command } from "commander";
import pc from "picocolors";
import {
  createWorkCommand,
  createWorkParallelCommand,
  createIterateCommand,
  createWatchCommand,
  createHistoryCommand,
  createResumeCommand,
  createStatusCommand,
  createParallelStatusCommand,
  createConfigCommand,
  createCleanupCommand,
  createDiscoverCommand,
  createSuggestCommand,
  createQueueCommand,
  createCancelCommand,
  createPrsCommand,
  createRunCommand,
  createInternalCommand,
} from "./commands/index.js";
import { logger } from "../infra/logger.js";

const VERSION = "0.1.0";

const program = new Command();

program
  .name("oss-agent")
  .description(pc.cyan("AI-powered agent for open source contributions and internal maintenance"))
  .version(VERSION, "-V, --version", "Output the version number")
  .option("-v, --verbose", "Enable verbose output")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) {
      logger.configure({ level: "debug", verbose: true });
    }
  });

// Register commands
program.addCommand(createWorkCommand());
program.addCommand(createWorkParallelCommand());
program.addCommand(createIterateCommand());
program.addCommand(createWatchCommand());
program.addCommand(createHistoryCommand());
program.addCommand(createResumeCommand());
program.addCommand(createStatusCommand());
program.addCommand(createParallelStatusCommand());
program.addCommand(createConfigCommand());
program.addCommand(createCleanupCommand());
program.addCommand(createDiscoverCommand());
program.addCommand(createSuggestCommand());
program.addCommand(createQueueCommand());
program.addCommand(createCancelCommand());
program.addCommand(createPrsCommand());
program.addCommand(createRunCommand());
program.addCommand(createInternalCommand());

// Error handling
program.exitOverride((err) => {
  if (err.code === "commander.help") {
    process.exit(0);
  }
  if (err.code === "commander.version") {
    process.exit(0);
  }
  logger.error(`Command failed: ${err.message}`);
  process.exit(1);
});

// Parse and execute
async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(error.message, error);
    }
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  logger.error("Unexpected error", error instanceof Error ? error : undefined);
  process.exit(1);
});
