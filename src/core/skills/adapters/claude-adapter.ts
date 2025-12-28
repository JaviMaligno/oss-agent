/**
 * Claude Skill Adapter
 *
 * Converts between universal skill format and Claude's SKILL.md format.
 */

import type {
  ClaudeSkillContent,
  ParsedClaudeSkill,
  ProviderType,
  SkillMetadata,
  UniversalSkill,
} from "../types.js";
import { BaseSkillAdapter, adapterFactory } from "./base-adapter.js";

/**
 * Adapter for Claude Code skills (SKILL.md format).
 */
export class ClaudeSkillAdapter extends BaseSkillAdapter<ParsedClaudeSkill> {
  provider: ProviderType = "claude";

  /**
   * Convert a universal skill to Claude's ParsedClaudeSkill format.
   */
  adapt(skill: UniversalSkill): ParsedClaudeSkill {
    const claudeContent = skill.providers.claude;

    if (!claudeContent) {
      throw new Error(`Skill "${skill.name}" does not have Claude provider content`);
    }

    // Build result with proper optional property handling for exactOptionalPropertyTypes
    const result: ParsedClaudeSkill = {
      name: skill.name,
      description: skill.description,
      content: claudeContent.content,
      directory: "", // Set by caller
      additionalDocs: claudeContent.additionalDocs ?? [],
    };

    // Only set optional properties if they have values
    if (skill.allowedTools && skill.allowedTools.length > 0) {
      result.allowedTools = skill.allowedTools;
    }
    if (claudeContent.model) {
      result.model = claudeContent.model;
    }

    return result;
  }

  /**
   * Parse a Claude ParsedClaudeSkill into a universal skill.
   */
  parse(input: ParsedClaudeSkill, metadata: SkillMetadata): UniversalSkill {
    // Build ClaudeSkillContent with proper optional property handling
    const claudeContent: ClaudeSkillContent = {
      content: input.content,
    };
    if (input.model) {
      claudeContent.model = input.model;
    }
    if (input.additionalDocs.length > 0) {
      claudeContent.additionalDocs = input.additionalDocs;
    }

    // Build UniversalSkill with proper optional property handling
    const result: UniversalSkill = {
      name: input.name,
      description: input.description,
      version: this.getVersion(metadata),
      providers: {
        claude: claudeContent,
      },
      requiredContext: [],
      examples: [],
    };

    // Only set optional properties if they have values
    if (input.allowedTools && input.allowedTools.length > 0) {
      result.allowedTools = input.allowedTools;
    }

    return result;
  }

  /**
   * Generate SKILL.md content from a ParsedClaudeSkill.
   */
  generateSkillMd(skill: ParsedClaudeSkill): string {
    const frontmatterLines = ["---"];

    frontmatterLines.push(`name: ${skill.name}`);
    frontmatterLines.push(`description: ${skill.description}`);

    if (skill.allowedTools && skill.allowedTools.length > 0) {
      frontmatterLines.push(`allowed-tools: ${skill.allowedTools.join(", ")}`);
    }

    if (skill.model) {
      frontmatterLines.push(`model: ${skill.model}`);
    }

    frontmatterLines.push("---");
    frontmatterLines.push("");
    frontmatterLines.push(skill.content);

    return frontmatterLines.join("\n");
  }

  /**
   * Convert a universal skill to SKILL.md content string.
   */
  toSkillMd(skill: UniversalSkill): string {
    const parsed = this.adapt(skill);
    return this.generateSkillMd(parsed);
  }
}

// Register the adapter
export const claudeAdapter = new ClaudeSkillAdapter();
adapterFactory.register(claudeAdapter);
