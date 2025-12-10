import { AIProvider } from "./types.js";
import { ClaudeCLIProvider } from "./claude-cli-provider.js";
import { ClaudeSDKProvider } from "./claude-sdk-provider.js";
import { Config } from "../../types/config.js";
import { logger } from "../../infra/logger.js";
import { ConfigurationError } from "../../infra/errors.js";
import { expandPath } from "../../cli/config/loader.js";

export interface ProviderFactoryOptions {
  /** Override the execution mode from config */
  forceMode?: "cli" | "sdk";
}

/**
 * Create an AI provider based on configuration.
 *
 * Priority:
 * 1. forceMode option (if provided)
 * 2. config.ai.executionMode
 * 3. Auto-detect: SDK if API key present, otherwise CLI
 */
export async function createProvider(
  config: Config,
  options: ProviderFactoryOptions = {}
): Promise<AIProvider> {
  const dataDir = expandPath(config.dataDir);
  const mode = options.forceMode ?? config.ai.executionMode;

  logger.debug(`Creating AI provider`, { mode, dataDir });

  // Determine which provider to use
  let provider: AIProvider;

  if (mode === "sdk") {
    provider = new ClaudeSDKProvider(config.ai, dataDir);
  } else {
    provider = new ClaudeCLIProvider(config.ai, dataDir);
  }

  // Verify provider is available
  const isAvailable = await provider.isAvailable();

  if (!isAvailable) {
    if (mode === "sdk") {
      // SDK not available, try falling back to CLI
      logger.warn("SDK mode requested but ANTHROPIC_API_KEY not set. Falling back to CLI mode.");
      const cliProvider = new ClaudeCLIProvider(config.ai, dataDir);
      const cliAvailable = await cliProvider.isAvailable();

      if (cliAvailable) {
        return cliProvider;
      }

      throw new ConfigurationError(
        "No AI provider available. SDK mode requires ANTHROPIC_API_KEY, " +
          "CLI mode requires 'claude' command in PATH."
      );
    } else {
      // CLI not available
      throw new ConfigurationError(
        `Claude CLI not found at '${config.ai.cli.path}'. ` +
          "Make sure Claude Code is installed and 'claude' is in your PATH, " +
          "or set ai.cli.path in config to the full path."
      );
    }
  }

  logger.info(`Using AI provider: ${provider.name}`);
  return provider;
}

/**
 * Auto-detect the best available provider.
 * Prefers CLI for local development (no API key needed).
 */
export async function autoDetectProvider(config: Config): Promise<AIProvider> {
  const dataDir = expandPath(config.dataDir);

  // First, try CLI (preferred for local dev)
  const cliProvider = new ClaudeCLIProvider(config.ai, dataDir);
  if (await cliProvider.isAvailable()) {
    logger.debug("Auto-detected: Claude CLI available");
    return cliProvider;
  }

  // Fall back to SDK if API key is set
  const sdkProvider = new ClaudeSDKProvider(config.ai, dataDir);
  if (await sdkProvider.isAvailable()) {
    logger.debug("Auto-detected: Claude SDK available");
    return sdkProvider;
  }

  throw new ConfigurationError(
    "No AI provider available. Either:\n" +
      "  1. Install Claude Code CLI ('claude' command), or\n" +
      "  2. Set ANTHROPIC_API_KEY environment variable"
  );
}
