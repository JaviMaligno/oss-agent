/**
 * Intelligent Search Agent
 *
 * Uses AI to interpret natural language queries and discover OSS projects
 * through web search, GitHub search, and curated list parsing.
 */

import { AIProvider } from "../../core/ai/index.js";
import { logger } from "../../infra/logger.js";
import type { Project } from "../../types/project.js";
import { DOMAIN_MAPPINGS, getDomainConfig, FRAMEWORK_MAPPINGS } from "./domain-mappings.js";

export interface IntelligentSearchConfig {
  /** Natural language query (e.g., "Python security tools for API testing") */
  query: string;

  /** Maximum projects to return (default: 20) */
  maxProjects?: number | undefined;

  /** Cost cap for the search in USD (default: 0.50) */
  maxBudgetUsd?: number | undefined;

  /** Model to use - prefer haiku for cost efficiency */
  model?: string | undefined;

  /** Search strategies to use */
  strategies?:
    | {
        useWebSearch?: boolean | undefined;
        useGitHubSearch?: boolean | undefined;
        useCuratedLists?: boolean | undefined;
      }
    | undefined;

  /** Working directory for agent execution */
  cwd?: string | undefined;
}

export interface AgentDiscoveryResult {
  projects: Array<{
    owner: string;
    repo: string;
    url: string;
    description: string;
    language: string;
    stars: number;
    relevance: "high" | "medium" | "low";
    reason: string;
  }>;
  searchStrategiesUsed: string[];
  totalCandidatesEvaluated: number;
}

/**
 * Build the search agent prompt based on configuration
 */
function buildSearchPrompt(config: IntelligentSearchConfig): string {
  const strategies = config.strategies ?? {
    useWebSearch: true,
    useGitHubSearch: true,
    useCuratedLists: true,
  };

  const maxProjects = config.maxProjects ?? 20;

  // Extract domain hints from the query for better searching
  const domainHints = extractDomainHints(config.query);

  return `You are a project discovery agent. Your task is to find open source projects matching this criteria:

"${config.query}"

${domainHints.length > 0 ? `\nDetected domains: ${domainHints.join(", ")}` : ""}

## Instructions

Use the available tools to search for relevant projects:

${strategies.useWebSearch ? `1. **Web Search**: Search for "best ${config.query} open source projects 2025" or similar queries to find curated recommendations and blog posts.` : ""}

${
  strategies.useGitHubSearch
    ? `2. **GitHub Search**: Use the \`gh\` CLI to search repositories:
   \`\`\`bash
   gh search repos "${extractKeywords(config.query)}" --json name,owner,url,description,stargazersCount,primaryLanguage --limit 30
   \`\`\`
   You can also add filters like \`--language=python\` or \`--stars=">100"\` based on the query.`
    : ""
}

${strategies.useCuratedLists ? `3. **Curated Lists**: Search for and fetch awesome-* lists related to the query domain. Parse them to extract project URLs.` : ""}

## Selection Criteria

Focus on projects that:
- Are **actively maintained** (commits in last 90 days)
- Have **good documentation** (README, docs folder)
- **Welcome contributions** (CONTRIBUTING.md, "good first issues" label)
- Have **responsive maintainers** (issues get responses)
- Match the user's requirements closely

## Output Format

After searching, output a JSON object with this exact structure:

\`\`\`json
{
  "projects": [
    {
      "owner": "organization-or-user",
      "repo": "repository-name",
      "url": "https://github.com/owner/repo",
      "description": "Brief description of what the project does",
      "language": "Primary language",
      "stars": 1234,
      "relevance": "high",
      "reason": "Why this project matches the query"
    }
  ],
  "searchStrategiesUsed": ["web_search", "github_search", "curated_lists"],
  "totalCandidatesEvaluated": 50
}
\`\`\`

Return the top ${maxProjects} most relevant projects, sorted by relevance and stars.

## Important

- Only include projects hosted on GitHub
- Verify each project URL is valid before including
- Do not include archived or unmaintained projects
- Focus on quality over quantity

Begin your search now.`;
}

/**
 * Extract domain hints from the query to improve search
 */
function extractDomainHints(query: string): string[] {
  const hints: string[] = [];
  const lowerQuery = query.toLowerCase();

  // Check for domain keywords
  for (const [domain, config] of Object.entries(DOMAIN_MAPPINGS)) {
    const domainConfig = config as { topics: string[]; keywords: string[] };
    const allKeywords = [...domainConfig.topics, ...domainConfig.keywords];

    for (const keyword of allKeywords) {
      if (lowerQuery.includes(keyword.toLowerCase())) {
        hints.push(domain);
        break;
      }
    }
  }

  // Check for framework keywords
  for (const [framework] of Object.entries(FRAMEWORK_MAPPINGS)) {
    if (lowerQuery.includes(framework.toLowerCase())) {
      hints.push(`framework:${framework}`);
    }
  }

  return [...new Set(hints)];
}

/**
 * Extract search keywords from natural language query
 */
function extractKeywords(query: string): string {
  // Remove common filler words
  const stopWords = [
    "a",
    "an",
    "the",
    "for",
    "with",
    "and",
    "or",
    "in",
    "on",
    "to",
    "that",
    "which",
    "are",
    "is",
    "be",
    "good",
    "best",
    "top",
    "open",
    "source",
    "projects",
    "tools",
    "libraries",
  ];

  const words = query
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((word) => !stopWords.includes(word) && word.length > 2);

  return words.slice(0, 5).join(" ");
}

/**
 * Parse the agent's JSON output into structured results
 */
function parseAgentOutput(output: string): AgentDiscoveryResult | null {
  try {
    // Try to extract JSON from the output
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
    const jsonStr = jsonMatch?.[1] ?? output;

    // Find the JSON object in the string
    const startIdx = jsonStr.indexOf("{");
    const endIdx = jsonStr.lastIndexOf("}");

    if (startIdx === -1 || endIdx === -1) {
      return null;
    }

    const parsed = JSON.parse(jsonStr.slice(startIdx, endIdx + 1)) as unknown;

    // Validate structure
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "projects" in parsed &&
      Array.isArray((parsed as AgentDiscoveryResult).projects)
    ) {
      return parsed as AgentDiscoveryResult;
    }

    return null;
  } catch (error) {
    logger.debug("Failed to parse agent output as JSON", { error });
    return null;
  }
}

/**
 * Convert agent results to Project objects
 */
function convertToProjects(result: AgentDiscoveryResult): Project[] {
  const now = new Date();

  return result.projects.map((p) => ({
    id: `${p.owner}/${p.repo}`,
    name: p.repo,
    fullName: `${p.owner}/${p.repo}`,
    owner: p.owner,
    url: p.url,
    description: p.description,
    language: p.language,
    stars: p.stars,
    forks: 0, // Not available from agent
    openIssues: 0, // Will be enriched later
    topics: [],
    license: null,
    defaultBranch: "main",
    hasContributingGuide: false, // Will be enriched later
    lastActivityAt: now,
    automatedTools: [],
  }));
}

/**
 * Run intelligent project discovery using an AI agent
 */
export async function intelligentDiscovery(
  config: IntelligentSearchConfig,
  aiProvider: AIProvider
): Promise<Project[]> {
  logger.info(`Starting intelligent discovery for: "${config.query}"`);

  const prompt = buildSearchPrompt(config);

  const result = await aiProvider.query(prompt, {
    cwd: config.cwd ?? process.cwd(),
    model: config.model ?? "claude-sonnet-4-20250514", // Use sonnet for better reasoning
    maxTurns: 20, // Allow enough turns for multi-step search
    timeoutMs: 5 * 60 * 1000, // 5 minute timeout
  });

  if (!result.success) {
    logger.error("Intelligent search agent failed", { error: result.error });
    return [];
  }

  const parsed = parseAgentOutput(result.output);

  if (!parsed) {
    logger.warn("Could not parse agent output, attempting fallback extraction");
    return extractProjectsFromRawOutput(result.output);
  }

  logger.info(
    `Agent found ${parsed.projects.length} projects using: ${parsed.searchStrategiesUsed.join(", ")}`
  );

  return convertToProjects(parsed);
}

/**
 * Fallback: extract GitHub URLs from raw output if JSON parsing fails
 */
function extractProjectsFromRawOutput(output: string): Project[] {
  const githubUrlRegex = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s)]+)/g;
  const matches = output.matchAll(githubUrlRegex);
  const seen = new Set<string>();
  const projects: Project[] = [];
  const now = new Date();

  for (const match of matches) {
    const owner = match[1];
    const repo = match[2]?.replace(/[^\w-]/g, ""); // Clean up repo name

    if (!owner || !repo) continue;

    const id = `${owner}/${repo}`;
    if (seen.has(id)) continue;
    seen.add(id);

    projects.push({
      id,
      name: repo,
      fullName: id,
      owner,
      url: `https://github.com/${owner}/${repo}`,
      description: "",
      language: null,
      stars: 0,
      forks: 0,
      openIssues: 0,
      topics: [],
      license: null,
      defaultBranch: "main",
      hasContributingGuide: false,
      lastActivityAt: now,
      automatedTools: [],
    });
  }

  logger.info(`Fallback extraction found ${projects.length} projects from URLs`);
  return projects;
}

/**
 * Get suggested search queries based on domain
 */
export function getSuggestedQueries(domain?: string): string[] {
  if (domain) {
    const domainConfig = getDomainConfig(domain);
    if (domainConfig) {
      return [
        `${domain} tools and libraries`,
        `${domain} ${domainConfig.topics[0] ?? ""} projects`,
        `best ${domain} open source projects`,
      ];
    }
  }

  return [
    "Python CLI tools for developers",
    "React component libraries with TypeScript",
    "Rust security scanning tools",
    "Go microservices frameworks",
    "Machine learning model serving tools",
  ];
}
