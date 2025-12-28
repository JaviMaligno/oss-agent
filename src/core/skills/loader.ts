/**
 * Skill Loader
 *
 * Loads skills from the filesystem (project and user directories).
 * Skills are stored as SKILL.md files with YAML frontmatter.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import { logger } from "../../infra/logger.js";
import {
  type ParsedClaudeSkill,
  type SkillLoadResult,
  type SkillLoadError,
  type SkillFrontmatter,
  SkillFrontmatterSchema,
} from "./types.js";

// =============================================================================
// Constants
// =============================================================================

const SKILL_FILE = "SKILL.md";
const PROJECT_SKILLS_DIR = ".claude/skills";
const USER_SKILLS_DIR = ".claude/skills";

// =============================================================================
// Frontmatter Parsing
// =============================================================================

interface ParsedFrontmatter {
  frontmatter: SkillFrontmatter;
  content: string;
}

/**
 * Parse YAML frontmatter from markdown content.
 * Frontmatter is delimited by --- at the start of the file.
 */
function parseFrontmatter(markdown: string): ParsedFrontmatter | null {
  const lines = markdown.split("\n");

  // Check for opening ---
  if (lines[0]?.trim() !== "---") {
    return null;
  }

  // Find closing ---
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    return null;
  }

  // Extract frontmatter YAML
  const yamlLines = lines.slice(1, closingIndex);

  // Parse YAML manually (simple key: value format)
  const frontmatterRaw: Record<string, string> = {};
  for (const line of yamlLines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      let value = line.slice(colonIndex + 1).trim();
      // Remove quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      frontmatterRaw[key] = value;
    }
  }

  // Validate with Zod
  const parsed = SkillFrontmatterSchema.safeParse(frontmatterRaw);
  if (!parsed.success) {
    logger.warn("Invalid skill frontmatter", {
      errors: parsed.error.errors,
      raw: frontmatterRaw,
    });
    return null;
  }

  // Extract content after frontmatter
  const content = lines
    .slice(closingIndex + 1)
    .join("\n")
    .trim();

  return {
    frontmatter: parsed.data,
    content,
  };
}

// =============================================================================
// Directory Scanning
// =============================================================================

/**
 * List all markdown files in a skill directory (excluding SKILL.md).
 */
async function listAdditionalDocs(skillDir: string): Promise<string[]> {
  try {
    const entries = await readdir(skillDir);
    const docs: string[] = [];

    for (const entry of entries) {
      if (entry.endsWith(".md") && entry !== SKILL_FILE && !entry.startsWith(".")) {
        docs.push(entry);
      }
    }

    return docs;
  } catch {
    return [];
  }
}

/**
 * Load a single skill from a directory.
 */
async function loadSkillFromDirectory(skillDir: string): Promise<ParsedClaudeSkill | null> {
  const skillPath = join(skillDir, SKILL_FILE);

  try {
    const content = await readFile(skillPath, "utf-8");
    const parsed = parseFrontmatter(content);

    if (!parsed) {
      logger.warn(`Invalid or missing frontmatter in ${skillPath}`);
      return null;
    }

    const additionalDocs = await listAdditionalDocs(skillDir);

    // Parse allowed-tools string into array
    const allowedToolsRaw = parsed.frontmatter["allowed-tools"];
    const allowedTools = allowedToolsRaw
      ? allowedToolsRaw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

    // Build result with proper optional property handling
    const result: ParsedClaudeSkill = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      content: parsed.content,
      directory: skillDir,
      additionalDocs,
    };

    // Only set optional properties if they have values
    if (allowedTools && allowedTools.length > 0) {
      result.allowedTools = allowedTools;
    }
    if (parsed.frontmatter.model) {
      result.model = parsed.frontmatter.model;
    }

    return result;
  } catch (error) {
    // Check for ENOENT (file not found) error
    const err = error as { code?: string };
    if (err.code === "ENOENT") {
      // SKILL.md doesn't exist, skip silently
      return null;
    }
    throw error;
  }
}

/**
 * Scan a directory for skill subdirectories.
 */
async function scanSkillsDirectory(
  baseDir: string
): Promise<{ skills: ParsedClaudeSkill[]; errors: SkillLoadError[] }> {
  const skills: ParsedClaudeSkill[] = [];
  const errors: SkillLoadError[] = [];

  try {
    const entries = await readdir(baseDir);

    for (const entry of entries) {
      // Skip hidden directories
      if (entry.startsWith(".")) continue;

      const entryPath = join(baseDir, entry);

      try {
        const stats = await stat(entryPath);
        if (!stats.isDirectory()) continue;

        const skill = await loadSkillFromDirectory(entryPath);
        if (skill) {
          skills.push(skill);
          logger.debug(`Loaded skill: ${skill.name}`, {
            directory: entryPath,
            additionalDocs: skill.additionalDocs.length,
          });
        }
      } catch (error) {
        errors.push({
          path: entryPath,
          message: `Failed to load skill: ${(error as Error).message}`,
          cause: error as Error,
        });
      }
    }
  } catch (error) {
    // Check for ENOENT (directory not found) error
    const err = error as { code?: string };
    if (err.code !== "ENOENT") {
      errors.push({
        path: baseDir,
        message: `Failed to scan skills directory: ${(error as Error).message}`,
        cause: error as Error,
      });
    }
  }

  return { skills, errors };
}

// =============================================================================
// Public API
// =============================================================================

export interface LoadSkillsOptions {
  /** Project directory to search for .claude/skills/ */
  projectDir?: string;
  /** Whether to load user skills from ~/.claude/skills/ */
  includeUserSkills?: boolean;
  /** Custom skills directory path (overrides default locations) */
  customDir?: string;
}

/**
 * Load skills from project and user directories.
 *
 * Search order:
 * 1. Custom directory (if provided)
 * 2. Project directory (.claude/skills/)
 * 3. User directory (~/.claude/skills/) if includeUserSkills is true
 *
 * Skills with the same name from earlier sources override later ones.
 */
export async function loadSkills(options: LoadSkillsOptions = {}): Promise<SkillLoadResult> {
  const { projectDir = process.cwd(), includeUserSkills = true, customDir } = options;

  const allSkills: ParsedClaudeSkill[] = [];
  const allErrors: SkillLoadError[] = [];
  const loadedNames = new Set<string>();

  // Helper to add skills without duplicates
  const addSkills = (skills: ParsedClaudeSkill[], errors: SkillLoadError[]): void => {
    for (const skill of skills) {
      if (!loadedNames.has(skill.name)) {
        allSkills.push(skill);
        loadedNames.add(skill.name);
      } else {
        logger.debug(`Skipping duplicate skill: ${skill.name}`);
      }
    }
    allErrors.push(...errors);
  };

  // 1. Custom directory (highest priority)
  if (customDir) {
    const result = await scanSkillsDirectory(resolve(customDir));
    addSkills(result.skills, result.errors);
  }

  // 2. Project directory
  const projectSkillsDir = resolve(projectDir, PROJECT_SKILLS_DIR);
  const projectResult = await scanSkillsDirectory(projectSkillsDir);
  addSkills(projectResult.skills, projectResult.errors);

  // 3. User directory (lowest priority)
  if (includeUserSkills) {
    const userSkillsDir = join(homedir(), USER_SKILLS_DIR);
    const userResult = await scanSkillsDirectory(userSkillsDir);
    addSkills(userResult.skills, userResult.errors);
  }

  logger.info(`Loaded ${allSkills.length} skills`, {
    names: allSkills.map((s) => s.name),
    errors: allErrors.length,
  });

  return {
    skills: allSkills,
    errors: allErrors,
  };
}

/**
 * Load a single skill by name from the default locations.
 */
export async function loadSkillByName(
  name: string,
  options: LoadSkillsOptions = {}
): Promise<ParsedClaudeSkill | null> {
  const result = await loadSkills(options);
  return result.skills.find((s) => s.name === name) ?? null;
}

/**
 * Read additional documentation file from a skill directory.
 */
export async function readSkillDoc(
  skill: ParsedClaudeSkill,
  docName: string
): Promise<string | null> {
  if (!skill.additionalDocs.includes(docName)) {
    return null;
  }

  try {
    const docPath = join(skill.directory, docName);
    return await readFile(docPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Get the full content of a skill including all additional docs.
 */
export async function getFullSkillContent(skill: ParsedClaudeSkill): Promise<string> {
  const parts = [skill.content];

  for (const docName of skill.additionalDocs) {
    const docContent = await readSkillDoc(skill, docName);
    if (docContent) {
      parts.push(`\n\n---\n\n# ${docName}\n\n${docContent}`);
    }
  }

  return parts.join("");
}
