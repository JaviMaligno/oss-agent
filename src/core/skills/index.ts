/**
 * Skills Module
 *
 * Provides skill loading, parsing, and adaptation for multiple AI providers.
 */

// Types
export type {
  UniversalSkill,
  ParsedClaudeSkill,
  ClaudeSkillContent,
  GeminiSkillContent,
  OpenAISkillContent,
  SkillExample,
  SkillLoadResult,
  SkillLoadError,
  SkillAdapter,
  SkillMetadata,
  ProviderType,
  SkillFrontmatter,
  SkillRegistry,
  SkillRegistryEntry,
} from "./types.js";

// Schemas
export { SkillFrontmatterSchema, SkillRegistrySchema, SkillRegistryEntrySchema } from "./types.js";

// Loader
export {
  loadSkills,
  loadSkillByName,
  readSkillDoc,
  getFullSkillContent,
  type LoadSkillsOptions,
} from "./loader.js";

// Adapters
export { BaseSkillAdapter, SkillAdapterFactory, adapterFactory } from "./adapters/base-adapter.js";
export { ClaudeSkillAdapter, claudeAdapter } from "./adapters/claude-adapter.js";
