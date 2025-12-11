/**
 * Curated List Parser - Extract project URLs from awesome-* lists
 */

import { spawn } from "node:child_process";
import { logger } from "../../infra/logger.js";

export interface ParsedProject {
  owner: string;
  repo: string;
  fullName: string;
  description?: string | undefined;
}

/**
 * Well-known curated lists organized by category
 */
export const CURATED_LISTS: Record<string, string[]> = {
  python: ["vinta/awesome-python", "trananhkma/awesome-python"],
  javascript: ["sorrycc/awesome-javascript", "enaqx/awesome-react", "vuejs/awesome-vue"],
  typescript: ["dzharii/awesome-typescript"],
  rust: ["rust-unofficial/awesome-rust"],
  go: ["avelino/awesome-go"],
  "machine-learning": [
    "josephmisiti/awesome-machine-learning",
    "ChristosChristofidis/awesome-deep-learning",
  ],
  security: ["sbilly/awesome-security", "enaqx/awesome-pentest"],
  devtools: ["agarrharr/awesome-cli-apps", "alebcay/awesome-shell"],
  "data-engineering": ["igorbarinov/awesome-data-engineering"],
  fastapi: ["mjhea0/awesome-fastapi"],
  django: ["wsvincent/awesome-django"],
};

/**
 * Parse an awesome-* list README to extract GitHub project links
 */
export async function parseCuratedList(listRepo: string): Promise<ParsedProject[]> {
  const projects: ParsedProject[] = [];

  try {
    // Fetch the README content from GitHub
    const content = await fetchReadme(listRepo);
    if (!content) {
      logger.warn(`Could not fetch README from ${listRepo}`);
      return projects;
    }

    // Parse GitHub links from markdown
    const githubLinkRegex =
      /\[([^\]]+)\]\(https?:\/\/github\.com\/([^/]+)\/([^/)]+)\/?(?:[^)]*)\)/g;
    let match;

    while ((match = githubLinkRegex.exec(content)) !== null) {
      const description = match[1];
      const owner = match[2];
      const repo = match[3]?.replace(/\.git$/, "") ?? "";

      // Skip if owner or repo is empty or if it's a link to issues/pulls/etc
      if (!owner || !repo || repo.includes("#") || repo.includes("?")) {
        continue;
      }

      // Skip common non-project links
      if (
        owner === "github" ||
        owner === "topics" ||
        repo === "issues" ||
        repo === "pulls" ||
        repo === "actions"
      ) {
        continue;
      }

      projects.push({
        owner,
        repo,
        fullName: `${owner}/${repo}`,
        description: description && description.length < 200 ? description : undefined,
      });
    }

    // Deduplicate by fullName
    const seen = new Set<string>();
    return projects.filter((p) => {
      if (seen.has(p.fullName)) {
        return false;
      }
      seen.add(p.fullName);
      return true;
    });
  } catch (error) {
    logger.error(`Failed to parse curated list ${listRepo}: ${error}`);
    return projects;
  }
}

/**
 * Fetch README content from a GitHub repository
 */
async function fetchReadme(repo: string): Promise<string | null> {
  // Try common README locations
  const readmeFiles = ["README.md", "readme.md", "Readme.md", "README.rst", "README"];

  for (const filename of readmeFiles) {
    try {
      const content = await gh(["api", `repos/${repo}/contents/${filename}`, "--jq", ".content"]);

      if (content) {
        // GitHub API returns base64 encoded content
        const decoded = Buffer.from(content.trim(), "base64").toString("utf-8");
        return decoded;
      }
    } catch {
      // Try next filename
      continue;
    }
  }

  return null;
}

/**
 * Get curated lists for a specific category/topic
 */
export function getCuratedListsForTopic(topic: string): string[] {
  const normalizedTopic = topic.toLowerCase().replace(/[- ]/g, "");

  // Direct match
  if (CURATED_LISTS[topic]) {
    return CURATED_LISTS[topic] ?? [];
  }

  // Try normalized match
  for (const [key, lists] of Object.entries(CURATED_LISTS)) {
    const normalizedKey = key.toLowerCase().replace(/[- ]/g, "");
    if (normalizedKey === normalizedTopic) {
      return lists;
    }
  }

  // Try partial match
  for (const [key, lists] of Object.entries(CURATED_LISTS)) {
    if (key.includes(topic) || topic.includes(key)) {
      return lists;
    }
  }

  return [];
}

/**
 * Get all available curated list categories
 */
export function getCuratedListCategories(): string[] {
  return Object.keys(CURATED_LISTS);
}

/**
 * Execute gh CLI command
 */
async function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("gh", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`gh ${args.join(" ")} failed: ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn gh: ${err.message}`));
    });
  });
}
