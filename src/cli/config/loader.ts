import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { Config, ConfigSchema } from "../../types/config.js";
import { ConfigurationError } from "../../infra/errors.js";
import { logger } from "../../infra/logger.js";

// Load .env file if it exists
loadEnv();

const DEFAULT_CONFIG_DIR = join(homedir(), ".oss-agent");
const CONFIG_FILE_NAME = "config.json";

export function expandPath(path: string): string {
  if (path.startsWith("~")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

export function getConfigDir(): string {
  return expandPath(process.env["OSS_AGENT_DATA_DIR"] ?? DEFAULT_CONFIG_DIR);
}

export function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILE_NAME);
}

export function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
    logger.debug(`Created config directory: ${configDir}`);
  }
}

export function loadConfig(): Config {
  const configPath = getConfigPath();

  let fileConfig: Partial<Config> = {};

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(content) as Partial<Config>;
      logger.debug(`Loaded config from ${configPath}`);
    } catch (error) {
      throw new ConfigurationError(
        `Failed to parse config file: ${configPath}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  // Merge with environment variables
  const envConfig: Partial<Config> = {};

  if (process.env["ANTHROPIC_API_KEY"]) {
    envConfig.ai = {
      provider: "claude" as const,
      executionMode: fileConfig.ai?.executionMode ?? "cli",
      model: fileConfig.ai?.model ?? "claude-sonnet-4-20250514",
      apiKey: process.env["ANTHROPIC_API_KEY"],
      cli: fileConfig.ai?.cli ?? {
        path: "claude",
        autoApprove: true,
        maxTurns: 50,
      },
    };
  }

  if (process.env["OSS_AGENT_MODE"]) {
    const mode = process.env["OSS_AGENT_MODE"];
    if (mode === "oss" || mode === "b2b") {
      envConfig.mode = mode;
    }
  }

  if (process.env["OSS_AGENT_VERBOSE"] === "true") {
    envConfig.verbose = true;
  }

  // Merge configs: defaults < file < env
  const merged = {
    ...fileConfig,
    ...envConfig,
    ai: { ...fileConfig.ai, ...envConfig.ai },
  };

  // Validate and parse with defaults
  const result = ConfigSchema.safeParse(merged);

  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
    throw new ConfigurationError(`Invalid configuration: ${errors}`);
  }

  return result.data;
}

export function saveConfig(config: Partial<Config>): void {
  ensureConfigDir();
  const configPath = getConfigPath();

  // Load existing config and merge
  let existing: Partial<Config> = {};
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      existing = JSON.parse(content) as Partial<Config>;
    } catch {
      // Ignore parse errors, will overwrite
    }
  }

  const merged = { ...existing, ...config };
  writeFileSync(configPath, JSON.stringify(merged, null, 2));
  logger.success(`Config saved to ${configPath}`);
}

export function getDefaultConfig(): Config {
  return ConfigSchema.parse({});
}
