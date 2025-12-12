/**
 * HookGenerator - Generates Claude Code hook scripts from templates
 *
 * Creates executable hook scripts with configured paths and generates
 * the .claude/settings.json configuration file.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../infra/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Options for hook generation
 */
export interface HookGeneratorOptions {
  /** Output directory for generated hooks */
  outputDir: string;
  /** Path to oss-agent CLI binary */
  cliPath: string;
  /** oss-agent data directory */
  dataDir: string;
}

/**
 * Claude Code settings structure
 */
export interface ClaudeSettings {
  hooks?: {
    SessionStart?: Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>;
    Stop?: Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>;
    SessionEnd?: Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>;
  };
}

/**
 * HookGenerator - Creates hook scripts and configuration
 */
export class HookGenerator {
  private templatesDir: string;

  constructor() {
    // Templates are relative to this file's location
    this.templatesDir = join(__dirname, "templates");
  }

  /**
   * Generate all hook scripts from templates
   */
  generateHooks(options: HookGeneratorOptions): void {
    const { outputDir, cliPath, dataDir } = options;

    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // Template variables
    const variables: Record<string, string> = {
      "{{OSS_AGENT_BIN}}": cliPath,
      "{{OSS_AGENT_DATA_DIR}}": dataDir,
    };

    // Generate each hook
    const hooks = ["session-start.sh", "stop.sh", "session-end.sh"];

    for (const hookName of hooks) {
      const templatePath = join(this.templatesDir, `${hookName}.template`);
      const outputPath = join(outputDir, hookName);

      if (!existsSync(templatePath)) {
        logger.warn(`Template not found: ${templatePath}`);
        continue;
      }

      try {
        let content = readFileSync(templatePath, "utf-8");

        // Replace variables
        for (const [key, value] of Object.entries(variables)) {
          content = content.replace(new RegExp(key, "g"), value);
        }

        // Write the hook script
        writeFileSync(outputPath, content, "utf-8");

        // Make executable
        chmodSync(outputPath, 0o755);

        logger.info(`Generated hook: ${outputPath}`);
      } catch (error) {
        logger.error(`Failed to generate hook ${hookName}: ${error}`);
        throw error;
      }
    }
  }

  /**
   * Generate .claude/settings.json configuration
   */
  generateSettings(options: { hooksDir: string; outputPath: string }): ClaudeSettings {
    const { hooksDir, outputPath } = options;

    const settings: ClaudeSettings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: join(hooksDir, "session-start.sh"),
                timeout: 30,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: join(hooksDir, "stop.sh"),
                timeout: 30,
              },
            ],
          },
        ],
        SessionEnd: [
          {
            hooks: [
              {
                type: "command",
                command: join(hooksDir, "session-end.sh"),
                timeout: 30,
              },
            ],
          },
        ],
      },
    };

    // Ensure output directory exists
    const settingsDir = dirname(outputPath);
    if (!existsSync(settingsDir)) {
      mkdirSync(settingsDir, { recursive: true });
    }

    // Write settings
    writeFileSync(outputPath, JSON.stringify(settings, null, 2), "utf-8");
    logger.info(`Generated settings: ${outputPath}`);

    return settings;
  }

  /**
   * Set up hooks for a project
   */
  setupForProject(options: { projectDir: string; cliPath?: string; dataDir?: string }): {
    hooksDir: string;
    settingsPath: string;
  } {
    const { projectDir } = options;
    const cliPath = options.cliPath ?? "node dist/cli/index.js";
    const dataDir = options.dataDir ?? "~/.oss-agent";

    const hooksDir = join(projectDir, ".claude", "hooks");
    const settingsPath = join(projectDir, ".claude", "settings.json");

    // Generate hooks
    this.generateHooks({
      outputDir: hooksDir,
      cliPath,
      dataDir,
    });

    // Generate settings
    this.generateSettings({
      hooksDir,
      outputPath: settingsPath,
    });

    return { hooksDir, settingsPath };
  }

  /**
   * Validate that hooks are properly set up
   */
  validateSetup(projectDir: string): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    const claudeDir = join(projectDir, ".claude");
    const hooksDir = join(claudeDir, "hooks");
    const settingsPath = join(claudeDir, "settings.json");

    // Check .claude directory
    if (!existsSync(claudeDir)) {
      errors.push(".claude directory not found");
      return { valid: false, errors, warnings };
    }

    // Check settings.json
    if (!existsSync(settingsPath)) {
      errors.push(".claude/settings.json not found");
    } else {
      try {
        const content = readFileSync(settingsPath, "utf-8");
        const settings = JSON.parse(content) as ClaudeSettings;

        if (!settings.hooks) {
          warnings.push("No hooks configured in settings.json");
        }
      } catch {
        errors.push("Invalid JSON in settings.json");
      }
    }

    // Check hooks directory
    if (!existsSync(hooksDir)) {
      errors.push(".claude/hooks directory not found");
    } else {
      // Check individual hooks
      const requiredHooks = ["session-start.sh", "stop.sh", "session-end.sh"];
      for (const hook of requiredHooks) {
        const hookPath = join(hooksDir, hook);
        if (!existsSync(hookPath)) {
          warnings.push(`Hook not found: ${hook}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
