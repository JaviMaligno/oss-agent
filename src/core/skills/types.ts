/**
 * Universal Skill Types
 *
 * Defines a provider-agnostic skill format that can be adapted
 * to different AI providers (Claude, Gemini, OpenAI).
 */

import { z } from "zod";

// =============================================================================
// Claude-specific types
// =============================================================================

export interface ClaudeSkillContent {
  /** Override model for this skill (e.g., "claude-opus-4-20250805") */
  model?: string;
  /** Main markdown content with instructions */
  content: string;
  /** Paths to additional documentation files */
  additionalDocs?: string[];
}

// =============================================================================
// Future provider types (stubs)
// =============================================================================

export interface GeminiSkillContent {
  /** System instruction for Gemini */
  systemInstruction?: string;
  /** Gemini-specific tool configuration */
  tools?: string[];
}

export interface OpenAISkillContent {
  /** Custom instructions for OpenAI */
  customInstructions?: string;
  /** Function definitions if applicable */
  functions?: string[];
}

// =============================================================================
// Universal Skill
// =============================================================================

export interface SkillExample {
  /** User input that triggers this skill */
  input: string;
  /** Expected behavior or output */
  expectedBehavior: string;
}

export interface UniversalSkill {
  /** Unique identifier (kebab-case, e.g., "feature-dev") */
  name: string;
  /** Description used for matching user requests (max 1024 chars) */
  description: string;
  /** Semantic version */
  version: string;

  /** Provider-specific content */
  providers: {
    claude?: ClaudeSkillContent;
    gemini?: GeminiSkillContent;
    openai?: OpenAISkillContent;
  };

  /** Tools allowed when this skill is active */
  allowedTools?: string[];
  /** Files to include in context when skill activates */
  requiredContext?: string[];
  /** Example triggers and expected behaviors */
  examples?: SkillExample[];
}

// =============================================================================
// Parsed Skill (from SKILL.md)
// =============================================================================

export interface ParsedClaudeSkill {
  /** Skill name from frontmatter */
  name: string;
  /** Skill description from frontmatter */
  description: string;
  /** Allowed tools from frontmatter */
  allowedTools?: string[];
  /** Model override from frontmatter */
  model?: string;
  /** Main markdown content (after frontmatter) */
  content: string;
  /** Directory containing the skill */
  directory: string;
  /** Additional documentation files in the directory */
  additionalDocs: string[];
}

// =============================================================================
// Skill Adapter Interface
// =============================================================================

export type ProviderType = "claude" | "gemini" | "openai";

export interface SkillAdapter<T = unknown> {
  /** Provider this adapter handles */
  provider: ProviderType;
  /** Convert universal skill to provider-specific format */
  adapt(skill: UniversalSkill): T;
  /** Parse provider-specific format into universal skill */
  parse(input: T, metadata: SkillMetadata): UniversalSkill;
}

export interface SkillMetadata {
  /** Directory containing the skill */
  directory: string;
  /** Version (from package.json or default "1.0.0") */
  version?: string;
}

// =============================================================================
// Skill Loader Types
// =============================================================================

export interface SkillLoadResult {
  /** Successfully loaded skills */
  skills: ParsedClaudeSkill[];
  /** Errors encountered during loading */
  errors: SkillLoadError[];
}

export interface SkillLoadError {
  /** Skill directory or file that caused the error */
  path: string;
  /** Error message */
  message: string;
  /** Original error if available */
  cause?: Error;
}

// =============================================================================
// Skill Registry Types (Future)
// =============================================================================

export interface SkillRegistryEntry {
  /** Skill name */
  name: string;
  /** Skill version */
  version: string;
  /** URL to download skill files */
  url: string;
  /** List of files in the skill */
  files: string[];
  /** SHA256 checksum for verification */
  checksum: string;
  /** Last updated timestamp */
  updatedAt: string;
}

export interface SkillRegistry {
  /** Registry version */
  version: string;
  /** Available skills */
  skills: SkillRegistryEntry[];
}

// =============================================================================
// Zod Schemas for validation
// =============================================================================

export const SkillFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Name must be kebab-case"),
  description: z.string().min(1).max(1024),
  "allowed-tools": z.string().optional(),
  model: z.string().optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export const SkillRegistryEntrySchema = z.object({
  name: z.string(),
  version: z.string(),
  url: z.string().url(),
  files: z.array(z.string()),
  checksum: z.string(),
  updatedAt: z.string().datetime(),
});

export const SkillRegistrySchema = z.object({
  version: z.string(),
  skills: z.array(SkillRegistryEntrySchema),
});
