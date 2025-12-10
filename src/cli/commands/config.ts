import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../../infra/logger.js";
import { loadConfig, saveConfig, getConfigPath, ensureConfigDir } from "../config/loader.js";

export function createConfigCommand(): Command {
  const command = new Command("config").description("View and manage configuration");

  command
    .command("show")
    .description("Show current configuration")
    .option("--json", "Output as JSON", false)
    .action((options: { json: boolean }) => {
      const config = loadConfig();

      if (options.json) {
        console.log(JSON.stringify(config, null, 2));
        return;
      }

      logger.header("OSS Agent - Configuration");
      console.error(pc.dim(`Config file: ${getConfigPath()}`));
      console.error("");
      console.error(JSON.stringify(config, null, 2));
    });

  command
    .command("set")
    .description("Set a configuration value")
    .argument("<key>", "Configuration key (e.g., ai.model, budget.dailyLimitUsd)")
    .argument("<value>", "Value to set")
    .action((key: string, value: string) => {
      ensureConfigDir();

      // Parse the key path
      const parts = key.split(".");

      // Parse value (handle numbers and booleans)
      let parsedValue: string | number | boolean = value;
      if (value === "true") parsedValue = true;
      else if (value === "false") parsedValue = false;
      else if (!isNaN(Number(value))) parsedValue = Number(value);

      // Build nested object
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const update: Record<string, any> = {};
      let current = update;

      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (part === undefined) continue;
        current[part] = {};
        current = current[part] as Record<string, unknown>;
      }

      const lastPart = parts[parts.length - 1];
      if (lastPart !== undefined) {
        current[lastPart] = parsedValue;
      }

      try {
        saveConfig(update);
        logger.success(`Set ${pc.cyan(key)} = ${pc.yellow(String(parsedValue))}`);
      } catch (error) {
        logger.error(`Failed to set config: ${key}`, error);
        process.exit(1);
      }
    });

  command
    .command("init")
    .description("Initialize configuration with defaults")
    .option("-f, --force", "Overwrite existing configuration", false)
    .action((options: { force: boolean }) => {
      const configPath = getConfigPath();

      try {
        const existingConfig = loadConfig();

        if (!options.force && existingConfig) {
          console.error(pc.yellow(`Config already exists at ${configPath}`));
          console.error(pc.dim("Use --force to overwrite"));
          return;
        }
      } catch {
        // No existing config, that's fine
      }

      ensureConfigDir();
      saveConfig({
        mode: "oss",
        ai: {
          provider: "claude",
          executionMode: "cli",
          model: "claude-sonnet-4-20250514",
          cli: {
            path: "claude",
            autoApprove: true,
            maxTurns: 50,
          },
        },
        budget: {
          dailyLimitUsd: 50,
          monthlyLimitUsd: 500,
          perIssueLimitUsd: 5,
          perFeedbackIterationUsd: 2,
        },
        git: {
          defaultBranch: "main",
          commitSignoff: false,
          branchPrefix: "oss-agent",
        },
        oss: {
          discoveryMode: "direct",
          directRepos: [],
          filterLabels: ["good first issue", "help wanted"],
          excludeLabels: ["wontfix", "duplicate", "invalid"],
          minStars: 100,
          maxStars: 50000,
          requireNoExistingPR: true,
          qualityGates: {
            maxPrsPerProjectPerDay: 2,
            maxPrsPerDay: 10,
            maxFilesChanged: 20,
            maxLinesChanged: 500,
            requireTestsPass: true,
            requireLintPass: true,
          },
        },
      });

      logger.success("Configuration initialized!");
      console.error(pc.dim(`\nEdit ${configPath} to customize settings`));
      console.error(pc.dim("Or use: oss-agent config set <key> <value>"));
    });

  command
    .command("path")
    .description("Show configuration file path")
    .action(() => {
      console.log(getConfigPath());
    });

  return command;
}
