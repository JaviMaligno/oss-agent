# Open Source Contribution Agent - System Design

## Overview

An automated system for discovering, contributing to, and managing open source contributions across multiple projects. The system finds relevant issues, creates PRs, monitors feedback, and iterates on changes.

---

## Key Innovation: Hooks-Based Feedback Loop

One of the most powerful aspects of this design is leveraging **Claude Code Hooks** to create a reactive, event-driven feedback loop. Instead of polling for PR feedback, hooks can:

1. **Detect when a session stops** after creating a PR
2. **Persist session state** for later resumption
3. **Trigger external monitoring** that watches for feedback
4. **Resume the exact session** with feedback context injected

This creates a "pause and resume" architecture that's more efficient than continuous polling.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Hooks-Based Feedback Architecture                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────┐     Stop Hook      ┌─────────────┐                        │
│   │   Claude    │ ──────────────────▶│   Session   │                        │
│   │   Session   │  (PR created,      │   State     │                        │
│   │  (working)  │   save session)    │   Store     │                        │
│   └─────────────┘                    └──────┬──────┘                        │
│          ▲                                  │                                │
│          │                                  ▼                                │
│          │                           ┌─────────────┐                        │
│          │                           │  Feedback   │◀─── GitHub Webhook     │
│          │                           │  Monitor    │◀─── Polling Service    │
│          │                           │  Service    │◀─── Sourcery/CodeRabbit│
│          │                           └──────┬──────┘                        │
│          │                                  │                                │
│          │   SessionStart Hook              │ Feedback detected!            │
│          │   (inject feedback context)      │                                │
│          │                                  ▼                                │
│          │                           ┌─────────────┐                        │
│          └───────────────────────────│   Resume    │                        │
│             claude --resume <id>     │   Trigger   │                        │
│                                      └─────────────┘                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           OSS Contribution Agent                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐          │
│  │  Project         │    │  Issue           │    │  Contribution    │          │
│  │  Discovery       │───▶│  Selection       │───▶│  Engine          │          │
│  │  Service         │    │  Service         │    │                  │          │
│  └──────────────────┘    └──────────────────┘    └────────┬─────────┘          │
│           │                       │                        │                    │
│           │                       │                        ▼                    │
│           │                       │              ┌──────────────────┐          │
│           │                       │              │  PR Monitoring   │          │
│           │                       │              │  & Feedback      │          │
│           │                       │              │  Handler         │          │
│           │                       │              └────────┬─────────┘          │
│           │                       │                        │                    │
│           ▼                       ▼                        ▼                    │
│  ┌────────────────────────────────────────────────────────────────────┐        │
│  │                     AI Provider Abstraction Layer                   │        │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                │        │
│  │  │ Claude      │  │ Gemini      │  │ Future      │                │        │
│  │  │ Agent SDK   │  │ CLI/SDK     │  │ Providers   │                │        │
│  │  └─────────────┘  └─────────────┘  └─────────────┘                │        │
│  └────────────────────────────────────────────────────────────────────┘        │
│           │                       │                        │                    │
│           ▼                       ▼                        ▼                    │
│  ┌────────────────────────────────────────────────────────────────────┐        │
│  │                        MCP Server Layer                             │        │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐       │        │
│  │  │ GitHub    │  │ Bitbucket │  │ GitLab    │  │ Custom    │       │        │
│  │  │ MCP       │  │ MCP       │  │ MCP       │  │ MCPs      │       │        │
│  │  └───────────┘  └───────────┘  └───────────┘  └───────────┘       │        │
│  └────────────────────────────────────────────────────────────────────┘        │
│                                                                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                           Control & Monitoring                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ Budget       │  │ Rate         │  │ Queue        │  │ State        │       │
│  │ Manager      │  │ Limiter      │  │ Manager      │  │ Persistence  │       │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Breakdown

### 1. Project Discovery Service

**Purpose**: Find relevant open source projects to contribute to.

The discovery service supports multiple modes from simple (direct repo) to intelligent (AI-powered domain search).

#### Discovery Modes

```typescript
interface ProjectDiscoveryConfig {
  // Discovery mode
  mode: {
    // "direct" - User provides specific repos
    // "search" - Search by criteria (language, domain, etc.)
    // "intelligent" - AI-powered discovery with natural language
    type: "direct" | "search" | "intelligent";

    // For "direct" mode: explicit repos
    directRepos: string[];            // ["python-poetry/poetry", "astral-sh/ruff"]

    // For "search" mode: structured criteria
    searchCriteria: SearchCriteria;

    // For "intelligent" mode: natural language + AI
    intelligentSearch: IntelligentSearchConfig;
  };

  // Common filters (apply to all modes except direct)
  filters: {
    minStars: number;                 // e.g., 100
    maxStars: number;                 // e.g., 50000 (avoid mega projects)
    hasGoodFirstIssues: boolean;
    lastActivityDays: number;         // Active in last N days
    licenseTypes: string[];           // ["MIT", "Apache-2.0"]
    excludeOrgs: string[];            // ["microsoft", "google"]
    includeOrgs: string[];            // Prioritize specific orgs

    // Automated feedback tools - prioritize repos with these for faster iteration
    automatedFeedback: AutomatedFeedbackFilter;
  };

  // Scoring weights for project ranking
  scoring: {
    issueResponseTime: number;        // How fast maintainers respond
    prMergeRate: number;              // % of PRs merged
    communityHealth: number;          // GitHub community health score
    documentationQuality: number;
    hasAutomatedFeedback: number;     // Bonus for repos with automated review
  };
}

// Filter/prioritize by automated feedback tools
interface AutomatedFeedbackFilter {
  // Require at least one automated feedback tool
  required: boolean;

  // Preferred tools (in priority order)
  preferred: AutomatedFeedbackTool[];

  // Boost score for repos with these tools
  scoreBoost: number;               // e.g., 20 points
}

type AutomatedFeedbackTool =
  | "sourcery"           // Sourcery AI - Python code review
  | "codeclimate"        // Code Climate - multi-language quality
  | "sonarcloud"         // SonarCloud/SonarQube - security & quality
  | "codecov"            // Codecov - coverage feedback
  | "coveralls"          // Coveralls - coverage feedback
  | "deepsource"         // DeepSource - code health
  | "codacy"             // Codacy - automated code review
  | "coderabbit"         // CodeRabbit - AI code review
  | "gitguardian"        // GitGuardian - secrets detection
  | "snyk"               // Snyk - security vulnerabilities
  | "dependabot"         // Dependabot - dependency updates
  | "renovate"           // Renovate - dependency updates
  | "pre-commit-ci"      // pre-commit.ci - linting/formatting
  | "github-actions-lint" // GitHub Actions with linting steps
  | "circleci"           // CircleCI with quality checks
  | "travisci";          // Travis CI with quality checks

// Structured search criteria
interface SearchCriteria {
  // Language/Framework filters
  languages: string[];                // ["Python", "TypeScript", "Rust"]
  frameworks: string[];               // ["FastAPI", "React", "Django"]

  // Domain/Category filters
  domains: string[];                  // ["ai-ml", "cybersecurity", "frontend", "devtools"]

  // GitHub-specific
  topics: string[];                   // GitHub topics: ["machine-learning", "cli"]

  // Discovery sources
  sources: {
    githubTrending: boolean;
    githubSearch: boolean;
    curatedLists: string[];           // ["awesome-python", "awesome-rust"]
    starredRepos: boolean;            // User's starred repos
  };
}

// AI-powered intelligent search
interface IntelligentSearchConfig {
  enabled: boolean;

  // Natural language query
  query: string;                      // "Python CLI tools for developers"
                                      // "Security scanning tools in Rust"
                                      // "React component libraries with good docs"

  // AI provider for search (can be lighter model)
  provider: "claude" | "gemini";
  model: string;                      // e.g., "claude-haiku" for cost efficiency

  // Search strategy
  strategy: {
    useWebSearch: boolean;            // Search web for "best X projects"
    useGitHubSearch: boolean;         // Construct GitHub search queries
    useCuratedLists: boolean;         // Find and parse awesome-* lists
    useHackerNews: boolean;           // Search HN for project mentions
    maxSearchQueries: number;         // Limit AI-generated searches
  };
}
```

#### Discovery Mode Examples

```yaml
# Mode 1: Direct - Just work on specific repos I care about
discovery:
  mode:
    type: direct
    directRepos:
      - python-poetry/poetry
      - astral-sh/ruff
      - pydantic/pydantic

# Mode 2: Search - Find projects by structured criteria
discovery:
  mode:
    type: search
    searchCriteria:
      languages: [Python, Rust]
      domains: [devtools, cli]
      frameworks: []
      topics: [developer-tools, command-line]
      sources:
        githubTrending: true
        githubSearch: true
        curatedLists: [awesome-python, awesome-cli-apps]
        starredRepos: true
  filters:
    minStars: 500
    maxStars: 20000
    hasGoodFirstIssues: true
    lastActivityDays: 30

# Mode 3: Intelligent - Let AI find relevant projects
discovery:
  mode:
    type: intelligent
    intelligentSearch:
      enabled: true
      query: "Python security tools for API testing and vulnerability scanning"
      provider: claude
      model: claude-haiku  # Use cheaper model for search
      strategy:
        useWebSearch: true
        useGitHubSearch: true
        useCuratedLists: true
        useHackerNews: false
        maxSearchQueries: 10
  filters:
    minStars: 100
    hasGoodFirstIssues: true
```

#### Intelligent Search Agent

For `intelligent` mode, we use a dedicated search agent:

```typescript
// search-agent.ts
import { query } from "@anthropic-ai/claude-agent-sdk";

async function intelligentProjectDiscovery(config: IntelligentSearchConfig): Promise<Project[]> {
  const searchPrompt = `
You are a project discovery agent. Find open source projects matching this criteria:

"${config.query}"

Use the available tools to:
1. Search the web for "best ${config.query} open source projects 2025"
2. Search GitHub for relevant repositories
3. Find and parse awesome-* lists related to this domain
4. Extract project URLs, descriptions, and key metrics

Return a JSON array of projects with: name, url, description, stars, language, lastActivity.

Focus on projects that:
- Are actively maintained (commits in last 30 days)
- Have good documentation
- Welcome contributions (look for CONTRIBUTING.md, good first issues)
- Have responsive maintainers

Limit to top 20 most relevant projects.
`;

  const result = await query({
    prompt: searchPrompt,
    options: {
      model: config.model || "claude-haiku",
      allowedTools: ["WebSearch", "WebFetch", "Bash"],  // Bash for gh CLI
      maxTurns: 15,
      maxBudgetUsd: 0.50,  // Cap search cost
      outputFormat: {
        type: "json_schema",
        schema: projectListSchema
      }
    }
  });

  // Parse and validate results
  return parseProjectResults(result);
}
```

#### Using gh CLI for Discovery

```bash
# Search by language and topic
gh search repos --language=python --topic=cli --stars=">500" --json name,url,description,stargazersCount

# Find repos with good first issues
gh search repos --language=rust --good-first-issues=">5" --json name,url

# Search by keyword
gh search repos "security scanner" --language=python --stars=">100"

# Get repo details including community health
gh api repos/owner/repo/community/profile
```

#### Domain Mappings

Pre-defined domain categories with associated topics and keywords:

```typescript
const DOMAIN_MAPPINGS: Record<string, DomainConfig> = {
  "ai-ml": {
    topics: ["machine-learning", "deep-learning", "artificial-intelligence", "nlp", "computer-vision"],
    keywords: ["transformer", "neural", "model", "training", "inference"],
    frameworks: ["pytorch", "tensorflow", "keras", "huggingface", "langchain"],
    curatedLists: ["awesome-machine-learning", "awesome-deep-learning"]
  },

  "cybersecurity": {
    topics: ["security", "pentesting", "vulnerability", "infosec", "devsecops"],
    keywords: ["scanner", "exploit", "audit", "compliance", "sast", "dast"],
    frameworks: ["burp", "metasploit", "nmap"],
    curatedLists: ["awesome-security", "awesome-hacking", "awesome-pentest"]
  },

  "frontend": {
    topics: ["frontend", "ui", "react", "vue", "svelte", "web-components"],
    keywords: ["component", "design-system", "ui-kit", "styling"],
    frameworks: ["react", "vue", "svelte", "angular", "nextjs", "nuxt"],
    curatedLists: ["awesome-react", "awesome-vue", "awesome-svelte"]
  },

  "devtools": {
    topics: ["developer-tools", "cli", "productivity", "automation"],
    keywords: ["linter", "formatter", "bundler", "compiler", "debugger"],
    frameworks: [],
    curatedLists: ["awesome-cli-apps", "awesome-devtools"]
  },

  "backend": {
    topics: ["backend", "api", "server", "microservices", "database"],
    keywords: ["rest", "graphql", "grpc", "orm", "queue"],
    frameworks: ["fastapi", "django", "flask", "express", "nestjs", "actix"],
    curatedLists: ["awesome-fastapi", "awesome-django"]
  },

  "data": {
    topics: ["data-engineering", "etl", "analytics", "visualization"],
    keywords: ["pipeline", "warehouse", "streaming", "batch"],
    frameworks: ["pandas", "spark", "dbt", "airflow", "dagster"],
    curatedLists: ["awesome-data-engineering", "awesome-etl"]
  }
};
```

**Implementation Approaches**:
- **Local**: Use gh CLI with user's credentials, optionally spawn Claude Code for intelligent search
- **Deployed**: Use GitHub API with configured token, scheduled discovery jobs

#### Detecting Automated Feedback Tools

```typescript
// Detection strategies for automated feedback tools
const AUTOMATED_FEEDBACK_DETECTION: Record<AutomatedFeedbackTool, DetectionStrategy> = {
  sourcery: {
    // Check for .sourcery.yaml config file
    configFiles: [".sourcery.yaml", ".sourcery.yml"],
    // Check GitHub App installation
    githubApp: "sourcery-ai",
    // Check PR comments from bot
    prCommentAuthors: ["sourcery-ai[bot]"],
  },

  codeclimate: {
    configFiles: [".codeclimate.yml", ".codeclimate.json"],
    githubApp: "codeclimate",
    prCommentAuthors: ["codeclimate[bot]"],
    checkBadge: /codeclimate\.com\/github/,
  },

  sonarcloud: {
    configFiles: ["sonar-project.properties", ".sonarcloud.properties"],
    githubApp: "sonarcloud",
    prCommentAuthors: ["sonarcloud[bot]"],
    checkBadge: /sonarcloud\.io/,
  },

  codecov: {
    configFiles: ["codecov.yml", ".codecov.yml", "codecov.yaml"],
    githubApp: "codecov",
    prCommentAuthors: ["codecov[bot]", "codecov-commenter"],
    checkBadge: /codecov\.io/,
  },

  coveralls: {
    configFiles: [".coveralls.yml"],
    prCommentAuthors: ["coveralls"],
    checkBadge: /coveralls\.io/,
  },

  deepsource: {
    configFiles: [".deepsource.toml"],
    githubApp: "deepsource",
    prCommentAuthors: ["deepsource-bot[bot]"],
  },

  codacy: {
    configFiles: [".codacy.yml", ".codacy.yaml"],
    githubApp: "codacy",
    prCommentAuthors: ["codacy[bot]"],
    checkBadge: /codacy\.com/,
  },

  coderabbit: {
    githubApp: "coderabbitai",
    prCommentAuthors: ["coderabbitai[bot]"],
  },

  gitguardian: {
    githubApp: "gitguardian",
    prCommentAuthors: ["gitguardian[bot]"],
  },

  snyk: {
    configFiles: [".snyk"],
    githubApp: "snyk",
    prCommentAuthors: ["snyk-bot[bot]"],
    checkBadge: /snyk\.io/,
  },

  dependabot: {
    configFiles: [".github/dependabot.yml", ".github/dependabot.yaml"],
    prCommentAuthors: ["dependabot[bot]"],
    prAuthors: ["dependabot[bot]"],  // Also creates PRs
  },

  renovate: {
    configFiles: ["renovate.json", "renovate.json5", ".renovaterc", ".renovaterc.json"],
    githubApp: "renovate",
    prCommentAuthors: ["renovate[bot]"],
    prAuthors: ["renovate[bot]"],
  },

  "pre-commit-ci": {
    configFiles: [".pre-commit-config.yaml"],
    prCommentAuthors: ["pre-commit-ci[bot]"],
    // Check for pre-commit.ci badge or comments
    checkBadge: /pre-commit\.ci/,
  },

  "github-actions-lint": {
    // Check workflow files for linting steps
    workflowPatterns: ["lint", "eslint", "pylint", "flake8", "black", "prettier", "ruff"],
  },

  circleci: {
    configFiles: [".circleci/config.yml"],
    prCommentAuthors: ["circleci[bot]"],
  },

  travisci: {
    configFiles: [".travis.yml"],
  },
};

async function detectAutomatedFeedbackTools(repo: string): Promise<AutomatedFeedbackTool[]> {
  const detected: AutomatedFeedbackTool[] = [];

  // 1. Check for config files in repo root
  const repoFiles = await listRepoFiles(repo, "");
  const githubFiles = await listRepoFiles(repo, ".github");

  for (const [tool, strategy] of Object.entries(AUTOMATED_FEEDBACK_DETECTION)) {
    let found = false;

    // Check config files
    if (strategy.configFiles) {
      for (const configFile of strategy.configFiles) {
        if (repoFiles.includes(configFile) || githubFiles.includes(configFile)) {
          found = true;
          break;
        }
      }
    }

    // Check recent PR comments for bot activity
    if (!found && strategy.prCommentAuthors) {
      const recentPRs = await getRecentPRs(repo, 10);
      for (const pr of recentPRs) {
        const comments = await getPRComments(repo, pr.number);
        if (comments.some(c => strategy.prCommentAuthors!.includes(c.author))) {
          found = true;
          break;
        }
      }
    }

    // Check README for badge
    if (!found && strategy.checkBadge) {
      const readme = await getReadme(repo);
      if (readme && strategy.checkBadge.test(readme)) {
        found = true;
      }
    }

    // Check GitHub Actions workflows for lint steps
    if (!found && strategy.workflowPatterns) {
      const workflows = await getWorkflowFiles(repo);
      for (const workflow of workflows) {
        const content = await getFileContent(repo, workflow);
        if (strategy.workflowPatterns.some(pattern =>
          content.toLowerCase().includes(pattern.toLowerCase())
        )) {
          found = true;
          break;
        }
      }
    }

    if (found) {
      detected.push(tool as AutomatedFeedbackTool);
    }
  }

  return detected;
}

// Quick detection using gh CLI
async function detectToolsViaCLI(repo: string): Promise<AutomatedFeedbackTool[]> {
  const detected: AutomatedFeedbackTool[] = [];

  // Check for common config files
  const configChecks = `
    gh api repos/${repo}/contents/.sourcery.yaml 2>/dev/null && echo "sourcery"
    gh api repos/${repo}/contents/.codeclimate.yml 2>/dev/null && echo "codeclimate"
    gh api repos/${repo}/contents/sonar-project.properties 2>/dev/null && echo "sonarcloud"
    gh api repos/${repo}/contents/codecov.yml 2>/dev/null && echo "codecov"
    gh api repos/${repo}/contents/.deepsource.toml 2>/dev/null && echo "deepsource"
    gh api repos/${repo}/contents/.github/dependabot.yml 2>/dev/null && echo "dependabot"
    gh api repos/${repo}/contents/renovate.json 2>/dev/null && echo "renovate"
    gh api repos/${repo}/contents/.pre-commit-config.yaml 2>/dev/null && echo "pre-commit-ci"
  `;

  // Check recent PR comments for bot authors
  const botCheck = `
    gh pr list --repo ${repo} --limit 5 --json number --jq '.[].number' | \
    xargs -I {} gh pr view {} --repo ${repo} --comments --json comments \
      --jq '.comments[].author.login' | sort -u | \
    grep -E '(sourcery-ai|codeclimate|sonarcloud|codecov|deepsource|coderabbitai|snyk-bot)'
  `;

  return detected;
}
```

#### Example: Filter for Repos with Automated Feedback

```yaml
# Prioritize repos with automated code review
discovery:
  mode:
    type: search
    searchCriteria:
      languages: [Python]
      domains: [devtools]

  filters:
    minStars: 200
    hasGoodFirstIssues: true

    # Automated feedback filter
    automatedFeedback:
      required: false              # Don't require, but boost score
      preferred:
        - sourcery                 # Best for Python
        - coderabbit               # Good AI review
        - codeclimate              # Solid quality checks
        - pre-commit-ci            # Fast linting feedback
      scoreBoost: 25               # +25 points for having any of these

  scoring:
    issueResponseTime: 30
    prMergeRate: 25
    communityHealth: 20
    documentationQuality: 10
    hasAutomatedFeedback: 15       # Extra weight for automated feedback

# Strict: Only repos with automated feedback
discovery:
  filters:
    automatedFeedback:
      required: true               # Must have at least one tool
      preferred: [sourcery, coderabbit, sonarcloud]
      scoreBoost: 0                # No extra boost since it's required
```

#### Why Automated Feedback Matters

| Aspect | Without Automated Feedback | With Automated Feedback |
|--------|---------------------------|-------------------------|
| **Feedback time** | Hours to days (human) | Seconds to minutes |
| **Iteration speed** | 1-2 cycles/day | 5-10 cycles/day |
| **Cost per issue** | Higher (more waiting) | Lower (fast fixes) |
| **Learning** | Generic human feedback | Specific, actionable |
| **Confidence** | Lower (subjective review) | Higher (consistent rules) |

### 2. Issue Selection Service

**Purpose**: Find and prioritize issues suitable for automated contribution.

```typescript
interface IssueSelectionConfig {
  // Issue filtering mode
  filterMode: {
    // "unassigned_no_pr" - Only issues without linked PRs (safest, avoids conflicts)
    // "all_open" - All open issues (may compete with existing PRs)
    // "custom" - Use custom criteria below
    mode: "unassigned_no_pr" | "all_open" | "custom";

    // When mode is "custom", these apply:
    customFilters: {
      hasNoPR: boolean;               // Exclude issues with linked PRs
      hasNoAssignee: boolean;         // Exclude assigned issues
      allowDraftPRs: boolean;         // Include issues with only draft PRs
      allowStalePRs: boolean;         // Include issues where PR is stale (>30 days)
      stalePRDays: number;            // Days before PR is considered stale
    };
  };

  // Issue criteria
  criteria: {
    labels: string[];                 // ["good first issue", "help wanted", "bug"]
    excludeLabels: string[];          // ["wontfix", "duplicate"]
    ageMinDays: number;               // At least N days old (avoid race)
    ageMaxDays: number;               // Not too stale
    hasReproSteps: boolean;           // For bugs
    complexity: "low" | "medium";     // Estimated complexity
  };

  // Concurrency limits
  limits: {
    maxOpenPRsPerProject: number;     // e.g., 2
    maxOpenPRsTotal: number;          // e.g., 10
    maxIssuesInQueue: number;         // e.g., 50
  };

  // AI-assisted filtering
  aiFiltering: {
    enabled: boolean;
    skipIfUnclear: boolean;           // Skip ambiguous issues
    requireTestPlan: boolean;         // Issue must have clear test criteria
  };

  // Parallel work configuration
  parallelWork: ParallelWorkConfig;
}

// Configuration for parallel issue work using git worktrees
interface ParallelWorkConfig {
  enabled: boolean;

  // Use git worktrees for parallel work on same repo
  useWorktrees: boolean;

  // Maximum parallel agents per project
  maxParallelPerProject: number;      // e.g., 3

  // Maximum total parallel agents
  maxParallelTotal: number;           // e.g., 5

  // Worktree base directory
  worktreeBaseDir: string;            // e.g., "~/.oss-agent/worktrees"

  // Resource limits per agent
  perAgentLimits: {
    maxBudgetUsd: number;             // e.g., 3.0
    maxTurns: number;                 // e.g., 50
    timeoutMinutes: number;           // e.g., 30
  };

  // Conflict detection
  conflictDetection: {
    enabled: boolean;
    // Check if issues might touch same files
    checkFileOverlap: boolean;
    // Avoid parallel work on related issues
    checkIssueReferences: boolean;
    // Min similarity to consider conflict
    overlapThreshold: number;         // e.g., 0.3 (30% file overlap)
  };
}
```

**Filter Mode Examples**:

```yaml
# Conservative: Only work on issues no one else is working on
filterMode:
  mode: unassigned_no_pr

# Aggressive: Work on any open issue (useful for your own projects)
filterMode:
  mode: all_open

# Custom: Include issues with stale PRs (abandoned work)
filterMode:
  mode: custom
  customFilters:
    hasNoPR: false           # Allow issues with PRs
    hasNoAssignee: false     # Allow assigned issues
    allowDraftPRs: true      # Include if only draft PRs exist
    allowStalePRs: true      # Include if PR is stale
    stalePRDays: 30          # PR older than 30 days = stale
```

**Issue Scoring Algorithm**:
```python
def score_issue(issue: Issue, project: Project, config: IssueSelectionConfig) -> float:
    score = 0.0

    # PR status scoring (when mode allows issues with PRs)
    if config.filterMode.mode != "unassigned_no_pr":
        if not issue.has_linked_pr:
            score += 40  # No PR = highest priority
        elif issue.linked_pr_is_draft:
            score += 20  # Draft PR = medium priority
        elif issue.linked_pr_is_stale:
            score += 30  # Stale PR = good opportunity
        else:
            score -= 20  # Active PR = lower priority (avoid conflict)

    # Assignee status
    if not issue.assignee:
        score += 15  # Unassigned = better

    # Base score from labels
    if "good first issue" in issue.labels:
        score += 30
    if "bug" in issue.labels:
        score += 20  # Bugs are usually clearer

    # Recency penalty (prefer newer but not too new)
    days_old = (now - issue.created_at).days
    if 3 <= days_old <= 30:
        score += 20
    elif days_old > 90:
        score -= 10

    # Project health
    score += project.pr_merge_rate * 20
    score += project.avg_response_time_score * 10

    # Clarity score (AI-assessed)
    score += issue.clarity_score * 20

    return score
```

**Issue Filtering Implementation**:
```python
def filter_issues(issues: list[Issue], config: IssueSelectionConfig) -> list[Issue]:
    """Filter issues based on configured mode."""

    mode = config.filterMode.mode

    if mode == "all_open":
        # Return all open issues (no filtering by PR/assignee)
        return issues

    if mode == "unassigned_no_pr":
        # Most conservative: no linked PRs, no assignee
        return [
            issue for issue in issues
            if not issue.has_linked_pr and not issue.assignee
        ]

    if mode == "custom":
        filters = config.filterMode.customFilters
        result = []

        for issue in issues:
            # Check PR filter
            if filters.hasNoPR and issue.has_linked_pr:
                # Has PR, but check exceptions
                if filters.allowDraftPRs and issue.linked_pr_is_draft:
                    pass  # Allow draft PRs
                elif filters.allowStalePRs and is_stale(issue.linked_pr, filters.stalePRDays):
                    pass  # Allow stale PRs
                else:
                    continue  # Skip this issue

            # Check assignee filter
            if filters.hasNoAssignee and issue.assignee:
                continue

            result.append(issue)

        return result

    return issues
```

### Parallel Work with Git Worktrees

Work on multiple issues from the same project simultaneously using git worktrees.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Parallel Worktree Architecture                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Main Repository (bare or regular)                                          │
│   ~/repos/python-poetry/poetry/                                              │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                         Git Worktrees                                │   │
│   │                                                                      │   │
│   │  ~/.oss-agent/worktrees/                                            │   │
│   │  ├── poetry-issue-10569/          ◄── Agent 1 working here          │   │
│   │  │   └── (full checkout)               Branch: fix/issue-10569      │   │
│   │  │                                                                   │   │
│   │  ├── poetry-issue-10234/          ◄── Agent 2 working here          │   │
│   │  │   └── (full checkout)               Branch: fix/issue-10234      │   │
│   │  │                                                                   │   │
│   │  └── poetry-issue-9876/           ◄── Agent 3 working here          │   │
│   │      └── (full checkout)               Branch: feat/issue-9876      │   │
│   │                                                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   Each worktree:                                                             │
│   • Has its own working directory                                            │
│   • Shares .git objects (efficient storage)                                  │
│   • Can have different branch checked out                                    │
│   • Runs independent Claude agent                                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Worktree Manager Implementation

```typescript
// worktree-manager.ts
import { spawn } from "child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";

interface WorktreeInfo {
  path: string;
  branch: string;
  issueId: string;
  agentSessionId?: string;
  status: "creating" | "ready" | "working" | "completed" | "failed";
  createdAt: Date;
}

class WorktreeManager {
  private worktrees: Map<string, WorktreeInfo> = new Map();
  private activeAgents: Map<string, AbortController> = new Map();

  constructor(
    private config: ParallelWorkConfig,
    private repoPath: string
  ) {}

  /**
   * Create a new worktree for an issue
   */
  async createWorktree(issue: Issue): Promise<WorktreeInfo> {
    const worktreeId = `${issue.repo.replace("/", "-")}-issue-${issue.number}`;
    const worktreePath = `${this.config.worktreeBaseDir}/${worktreeId}`;
    const branchName = this.generateBranchName(issue);

    // Check if we can create more worktrees
    const activeCount = this.getActiveWorktreeCount(issue.repo);
    if (activeCount >= this.config.maxParallelPerProject) {
      throw new Error(`Max parallel worktrees (${this.config.maxParallelPerProject}) reached for ${issue.repo}`);
    }

    // Create the worktree with a new branch
    await this.execGit([
      "worktree", "add",
      "-b", branchName,
      worktreePath,
      "origin/main"  // Base branch
    ]);

    const info: WorktreeInfo = {
      path: worktreePath,
      branch: branchName,
      issueId: `${issue.repo}#${issue.number}`,
      status: "ready",
      createdAt: new Date()
    };

    this.worktrees.set(worktreeId, info);
    return info;
  }

  /**
   * Launch an agent in a worktree
   */
  async launchAgent(worktree: WorktreeInfo, issue: Issue): Promise<string> {
    worktree.status = "working";

    const agentPrompt = this.buildAgentPrompt(issue);
    const abortController = new AbortController();

    // Store abort controller for cancellation
    this.activeAgents.set(worktree.issueId, abortController);

    try {
      const result = await query({
        prompt: agentPrompt,
        options: {
          cwd: worktree.path,
          model: "claude-sonnet-4-20250514",
          allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
          maxTurns: this.config.perAgentLimits.maxTurns,
          maxBudgetUsd: this.config.perAgentLimits.maxBudgetUsd,
          permissionMode: "acceptEdits",
          abortSignal: abortController.signal
        }
      });

      worktree.agentSessionId = result.sessionId;
      worktree.status = "completed";
      return result.sessionId;

    } catch (error) {
      worktree.status = "failed";
      throw error;
    } finally {
      this.activeAgents.delete(worktree.issueId);
    }
  }

  /**
   * Launch multiple agents in parallel
   */
  async launchParallelAgents(issues: Issue[]): Promise<Map<string, WorktreeInfo>> {
    // Check for potential conflicts
    if (this.config.conflictDetection.enabled) {
      issues = await this.filterConflictingIssues(issues);
    }

    // Limit to max parallel
    const toProcess = issues.slice(0, this.config.maxParallelTotal);

    // Create all worktrees first
    const worktrees = await Promise.all(
      toProcess.map(issue => this.createWorktree(issue))
    );

    // Launch all agents in parallel
    const results = await Promise.allSettled(
      worktrees.map((wt, i) => this.launchAgent(wt, toProcess[i]))
    );

    // Log results
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        console.log(`✓ Agent completed for ${toProcess[i].number}`);
      } else {
        console.error(`✗ Agent failed for ${toProcess[i].number}: ${result.reason}`);
      }
    });

    return this.worktrees;
  }

  /**
   * Detect potential conflicts between issues
   */
  async filterConflictingIssues(issues: Issue[]): Promise<Issue[]> {
    const nonConflicting: Issue[] = [];
    const predictedFiles: Map<string, Set<string>> = new Map();

    for (const issue of issues) {
      // Use AI to predict which files might be touched
      const files = await this.predictAffectedFiles(issue);
      const issueKey = `${issue.repo}#${issue.number}`;
      predictedFiles.set(issueKey, new Set(files));

      // Check overlap with already selected issues
      let hasConflict = false;
      for (const selected of nonConflicting) {
        const selectedKey = `${selected.repo}#${selected.number}`;
        const selectedFiles = predictedFiles.get(selectedKey)!;

        const overlap = this.calculateOverlap(files, [...selectedFiles]);
        if (overlap > this.config.conflictDetection.overlapThreshold) {
          console.log(`Skipping ${issueKey}: ${(overlap * 100).toFixed(0)}% overlap with ${selectedKey}`);
          hasConflict = true;
          break;
        }
      }

      if (!hasConflict) {
        nonConflicting.push(issue);
      }
    }

    return nonConflicting;
  }

  /**
   * Predict which files an issue might affect (using AI)
   */
  async predictAffectedFiles(issue: Issue): Promise<string[]> {
    const result = await query({
      prompt: `
Analyze this issue and predict which files in the codebase might need to be modified.

Issue #${issue.number}: ${issue.title}

${issue.body}

Based on the issue description, list the likely file paths that would need changes.
Return only a JSON array of file path patterns, e.g.:
["src/utils/*.py", "tests/test_utils.py", "src/core/parser.py"]
`,
      options: {
        model: "claude-haiku",  // Use cheap model for prediction
        maxTurns: 3,
        maxBudgetUsd: 0.05,
        outputFormat: { type: "json" }
      }
    });

    return JSON.parse(result.output);
  }

  /**
   * Clean up a worktree after work is done
   */
  async cleanupWorktree(worktreeId: string): Promise<void> {
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) return;

    // Remove the worktree
    await this.execGit(["worktree", "remove", worktree.path, "--force"]);

    // Optionally delete the branch if PR was merged
    // await this.execGit(["branch", "-d", worktree.branch]);

    this.worktrees.delete(worktreeId);
  }

  /**
   * Cancel a running agent
   */
  cancelAgent(issueId: string): boolean {
    const controller = this.activeAgents.get(issueId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  private generateBranchName(issue: Issue): string {
    const prefix = issue.labels.includes("bug") ? "fix" : "feat";
    const slug = issue.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 30);
    return `${prefix}/issue-${issue.number}-${slug}`;
  }

  private calculateOverlap(files1: string[], files2: string[]): number {
    const set1 = new Set(files1);
    const set2 = new Set(files2);
    const intersection = [...set1].filter(f => set2.has(f));
    const union = new Set([...set1, ...set2]);
    return intersection.length / union.size;
  }

  private getActiveWorktreeCount(repo: string): number {
    return [...this.worktrees.values()]
      .filter(wt => wt.issueId.startsWith(repo) && wt.status === "working")
      .length;
  }

  private async execGit(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("git", args, { cwd: this.repoPath });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", d => stdout += d);
      proc.stderr.on("data", d => stderr += d);
      proc.on("close", code => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr));
      });
    });
  }
}
```

#### CLI Commands for Parallel Work

```bash
# Work on multiple issues in parallel
oss-agent work-parallel --project python-poetry/poetry --issues 10569,10234,9876

# Auto-select issues and work in parallel
oss-agent work-parallel --project python-poetry/poetry --count 3

# Check status of parallel work
oss-agent parallel-status

# Output:
# ┌────────────────────────────────────────────────────────────────┐
# │ Parallel Work Status                                           │
# ├────────────────────────────────────────────────────────────────┤
# │ poetry-issue-10569  │ working   │ 15 turns │ $1.20 spent       │
# │ poetry-issue-10234  │ completed │ PR #10655 created            │
# │ poetry-issue-9876   │ working   │ 8 turns  │ $0.65 spent       │
# └────────────────────────────────────────────────────────────────┘

# Cancel a specific agent
oss-agent cancel --issue python-poetry/poetry#10569

# Clean up all worktrees for a project
oss-agent worktree-cleanup --project python-poetry/poetry
```

#### Parallel Work Configuration Examples

```yaml
# Conservative: Limited parallelism
parallelWork:
  enabled: true
  useWorktrees: true
  maxParallelPerProject: 2
  maxParallelTotal: 3
  worktreeBaseDir: ~/.oss-agent/worktrees

  perAgentLimits:
    maxBudgetUsd: 2.0
    maxTurns: 30
    timeoutMinutes: 20

  conflictDetection:
    enabled: true
    checkFileOverlap: true
    checkIssueReferences: true
    overlapThreshold: 0.2          # 20% overlap = conflict

# Aggressive: High parallelism for your own projects
parallelWork:
  enabled: true
  useWorktrees: true
  maxParallelPerProject: 5
  maxParallelTotal: 10
  worktreeBaseDir: ~/.oss-agent/worktrees

  perAgentLimits:
    maxBudgetUsd: 5.0
    maxTurns: 50
    timeoutMinutes: 45

  conflictDetection:
    enabled: true
    checkFileOverlap: true
    overlapThreshold: 0.5          # More tolerant of overlap
```

#### Resource Management

```typescript
interface ParallelResourceManager {
  // Track total resource usage across all agents
  totalBudgetUsed: number;
  totalBudgetLimit: number;

  // Track per-project usage
  projectUsage: Map<string, {
    activeAgents: number;
    budgetUsed: number;
    issuesCompleted: number;
  }>;

  // Semaphore for limiting concurrent agents
  agentSemaphore: Semaphore;

  // Methods
  canStartAgent(project: string): boolean;
  reserveResources(project: string, budget: number): boolean;
  releaseResources(project: string, budgetUsed: number): void;
}

// Example usage with semaphore
async function runParallelAgents(issues: Issue[], config: ParallelWorkConfig) {
  const semaphore = new Semaphore(config.maxParallelTotal);
  const manager = new WorktreeManager(config, repoPath);

  const tasks = issues.map(async (issue) => {
    // Wait for available slot
    await semaphore.acquire();

    try {
      const worktree = await manager.createWorktree(issue);
      await manager.launchAgent(worktree, issue);
    } finally {
      // Release slot for next agent
      semaphore.release();
    }
  });

  // Wait for all to complete
  await Promise.allSettled(tasks);
}
```

#### Benefits of Worktree-Based Parallelism

| Aspect | Without Worktrees | With Worktrees |
|--------|-------------------|----------------|
| **Storage** | Clone repo per issue | Shared .git objects |
| **Setup time** | Full clone (~minutes) | Worktree add (~seconds) |
| **Disk usage** | N × repo size | 1 × repo + N × working files |
| **Branch conflicts** | Must clone separately | Native git isolation |
| **Cleanup** | Delete entire clone | `git worktree remove` |

### 3. Contribution Engine

**Purpose**: The core AI agent that works on issues.

```typescript
interface ContributionEngineConfig {
  // AI Provider selection
  provider: {
    primary: "claude" | "gemini";
    fallback: "gemini" | "claude" | null;

    // Claude-specific
    claude: {
      apiKey: string | null;          // Use env ANTHROPIC_API_KEY if null
      model: "claude-opus-4-5-20251101" | "claude-sonnet-4-5";
      maxBudgetPerIssue: number;      // USD
      maxTurns: number;
    };

    // Gemini-specific (fallback)
    gemini: {
      apiKey: string | null;
      model: string;
      maxTokens: number;
    };
  };

  // Contribution workflow
  workflow: {
    // Step 1: Understand
    understand: {
      readIssue: boolean;
      readRelatedCode: boolean;
      readTests: boolean;
      readContributingGuide: boolean;
    };

    // Step 2: Plan
    plan: {
      createImplementationPlan: boolean;
      estimateComplexity: boolean;
      identifyRisks: boolean;
    };

    // Step 3: Implement
    implement: {
      writeCode: boolean;
      writeTests: boolean;
      runTests: boolean;
      runLinting: boolean;
    };

    // Step 4: Submit
    submit: {
      createBranch: boolean;
      commitWithConventions: boolean;
      createPR: boolean;
      linkIssue: boolean;
    };
  };

  // Safety settings
  safety: {
    maxFilesChanged: number;          // e.g., 20
    maxLinesChanged: number;          // e.g., 500
    allowedFilePatterns: string[];    // ["src/**", "tests/**"]
    disallowedPatterns: string[];     // ["*.env", "secrets/*"]
    requireTestsPass: boolean;
    requireLintPass: boolean;
  };
}
```

### 4. PR Monitoring & Feedback Handler

**Purpose**: Monitor PRs for feedback and iterate.

```typescript
interface FeedbackHandlerConfig {
  // Monitoring configuration
  monitoring: {
    pollIntervalMinutes: number;      // For APIs without webhooks
    webhookEndpoint: string | null;   // For webhook-capable platforms

    // What to monitor
    events: {
      reviewComments: boolean;
      ciStatus: boolean;
      labelChanges: boolean;
      maintainerRequests: boolean;
    };
  };

  // Response configuration
  response: {
    // Automatic responses
    autoRespond: {
      ciFailure: boolean;             // Auto-fix CI failures
      styleIssues: boolean;           // Auto-fix style/lint
      minorChanges: boolean;          // <10 lines requested
    };

    // Manual intervention triggers
    requireHuman: {
      architecturalChanges: boolean;
      scopeExpansion: boolean;
      conflictingFeedback: boolean;
      afterNIterations: number;       // e.g., 3
    };

    // Limits
    maxIterations: number;            // e.g., 5
    maxBudgetPerPR: number;           // USD
  };

  // Notification settings
  notifications: {
    slack: string | null;
    email: string | null;
    discord: string | null;
  };
}
```

**Feedback Detection Patterns**:
```typescript
interface FeedbackSource {
  type: "automated" | "human";

  // Automated feedback sources
  automated: {
    sourceryAi: boolean;              // Like in your poetry PR
    codeRabbit: boolean;
    githubActions: boolean;
    preLinters: boolean;
  };

  // Human feedback patterns
  human: {
    // Keywords that indicate feedback
    changeRequestKeywords: [
      "please", "could you", "should", "consider",
      "instead", "rather", "better if"
    ];

    // Approval indicators
    approvalKeywords: [
      "LGTM", "looks good", "approved", "ship it"
    ];
  };
}
```

### 5. AI Provider Abstraction Layer

**Purpose**: Unified interface supporting multiple AI providers.

```typescript
// Abstract interface
interface AIProvider {
  name: string;

  // Core operations
  query(prompt: string, options: QueryOptions): AsyncIterable<Message>;

  // Tool support
  supportedTools(): string[];
  registerTool(tool: Tool): void;

  // Session management
  createSession(): Session;
  resumeSession(id: string): Session;

  // Cost tracking
  getUsage(): UsageStats;
  getRemainingBudget(): number;
}

// Claude implementation
class ClaudeProvider implements AIProvider {
  private sdk: ClaudeSDKClient;

  async *query(prompt: string, options: QueryOptions) {
    const result = await query({
      prompt,
      options: {
        model: options.model || "claude-sonnet-4-5",
        allowedTools: options.tools,
        permissionMode: "acceptEdits",
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudget,
        mcpServers: options.mcpServers
      }
    });

    for await (const message of result) {
      yield this.normalizeMessage(message);
    }
  }
}

// Gemini implementation (fallback)
class GeminiProvider implements AIProvider {
  private client: GeminiClient;

  async *query(prompt: string, options: QueryOptions) {
    // Gemini-specific implementation
    // Map tools to Gemini function calling format
    // Handle streaming responses
  }
}

// Provider factory with automatic fallback
class AIProviderFactory {
  static create(config: ProviderConfig): AIProvider {
    // Check for Anthropic API key
    if (process.env.ANTHROPIC_API_KEY || config.claude?.apiKey) {
      return new ClaudeProvider(config.claude);
    }

    // Fall back to Gemini
    if (process.env.GOOGLE_API_KEY || config.gemini?.apiKey) {
      return new GeminiProvider(config.gemini);
    }

    throw new Error("No AI provider configured");
  }
}
```

### 6. MCP Server Layer

**Purpose**: Extensible tool integration via MCP protocol.

```typescript
interface MCPConfiguration {
  // Transport mode based on deployment
  transport: {
    // Local mode: stdio for all servers
    local: {
      type: "stdio";
      servers: {
        [name: string]: {
          command: string;
          args: string[];
          env: Record<string, string>;
        };
      };
    };

    // Deployed mode: mixed transports
    deployed: {
      type: "mixed";
      servers: {
        // HTTP/SSE for remote servers
        github: {
          type: "sse";
          url: string;
          headers: Record<string, string>;
        };

        // SDK server for custom tools (in-process)
        custom: {
          type: "sdk";
          instance: MCPServer;
        };
      };

      // Stdio proxy for deployed environment
      stdioProxy: {
        enabled: boolean;
        bridgeUrl: string;  // Sidecar service that bridges stdio
      };
    };
  };
}
```

**Stdio Proxy Pattern for Deployed Environments**:
```
┌─────────────────────────────────────────────────────────────┐
│                    Deployed Agent (Render)                   │
│  ┌─────────────────┐        ┌─────────────────────────────┐ │
│  │  Agent Core     │◀──────▶│  MCP Bridge Service         │ │
│  │  (HTTP/SSE)     │        │  (Sidecar Container)        │ │
│  └─────────────────┘        │                             │ │
│                             │  ┌───────────────────────┐  │ │
│                             │  │ stdio MCP Server 1    │  │ │
│                             │  └───────────────────────┘  │ │
│                             │  ┌───────────────────────┐  │ │
│                             │  │ stdio MCP Server 2    │  │ │
│                             │  └───────────────────────┘  │ │
│                             └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 7. Budget & Rate Limiting

**Purpose**: Prevent runaway costs and API abuse.

```typescript
interface BudgetConfig {
  // Global limits
  global: {
    dailyBudgetUsd: number;           // e.g., 50
    monthlyBudgetUsd: number;         // e.g., 500

    // Hard stops
    hardStopAtPercent: number;        // e.g., 90 (warn at 90%)
    pauseAtPercent: number;           // e.g., 100
  };

  // Per-operation limits
  operations: {
    perIssue: {
      maxBudgetUsd: number;           // e.g., 5
      maxTurns: number;               // e.g., 30
      maxTime: number;                // Minutes
    };

    perFeedbackIteration: {
      maxBudgetUsd: number;           // e.g., 2
      maxTurns: number;               // e.g., 10
    };

    perProjectDiscovery: {
      maxBudgetUsd: number;           // e.g., 1
    };
  };

  // Rate limiting
  rateLimits: {
    issuesPerHour: number;            // e.g., 2
    prsPerDay: number;                // e.g., 5
    apiCallsPerMinute: number;        // e.g., 60
  };

  // Circuit breaker
  circuitBreaker: {
    failureThreshold: number;         // e.g., 5 consecutive failures
    resetTimeMinutes: number;         // e.g., 30
  };
}
```

**Budget Tracking Implementation**:
```typescript
class BudgetManager {
  private db: Database;

  async trackUsage(operation: string, cost: number): Promise<void> {
    await this.db.insert('usage', {
      timestamp: new Date(),
      operation,
      cost
    });
  }

  async canProceed(operation: string, estimatedCost: number): Promise<boolean> {
    const daily = await this.getDailySpend();
    const monthly = await this.getMonthlySpend();
    const config = this.config;

    // Check global limits
    if (daily + estimatedCost > config.global.dailyBudgetUsd) {
      this.notify("Daily budget limit approaching");
      return false;
    }

    if (monthly + estimatedCost > config.global.monthlyBudgetUsd) {
      this.notify("Monthly budget limit reached");
      return false;
    }

    return true;
  }

  async getStatus(): Promise<BudgetStatus> {
    return {
      dailySpent: await this.getDailySpend(),
      dailyLimit: this.config.global.dailyBudgetUsd,
      monthlySpent: await this.getMonthlySpend(),
      monthlyLimit: this.config.global.monthlyBudgetUsd,
      operationsToday: await this.getOperationCount('today'),
      remainingIssues: this.calculateRemainingIssues()
    };
  }
}
```

### 8. State Persistence

**Purpose**: Track all operations, enable resume, provide audit trail.

```typescript
interface StateSchema {
  // Projects being tracked
  projects: {
    id: string;
    url: string;
    lastScanned: Date;
    score: number;
    stats: ProjectStats;
  }[];

  // Issues in various states
  issues: {
    id: string;
    projectId: string;
    url: string;
    state: "discovered" | "queued" | "in_progress" | "pr_created" |
           "awaiting_feedback" | "iterating" | "merged" | "closed" | "abandoned";
    priority: number;
    attempts: number;
    sessionId: string | null;         // For resuming AI sessions
    prUrl: string | null;
    history: StateTransition[];
  }[];

  // Active sessions (for resume)
  sessions: {
    id: string;
    issueId: string;
    provider: string;
    startedAt: Date;
    lastActivity: Date;
    turnCount: number;
    costUsd: number;
    canResume: boolean;
  }[];

  // Audit log
  auditLog: {
    timestamp: Date;
    action: string;
    details: object;
    cost: number | null;
  }[];
}
```

### 9. Claude Code Hooks Integration

**Purpose**: Event-driven automation using Claude Code's native hook system.

Hooks are the **key enabler** for the feedback loop. They allow us to:
- Capture session state when work completes
- Inject context when resuming
- React to specific tool executions (like PR creation)
- Create a fully automated pause/resume workflow

#### Hook Configuration (`.claude/settings.json`)

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/on-session-stop.sh",
            "timeout": 30
          }
        ]
      }
    ],

    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/on-session-start.sh",
            "timeout": 10
          }
        ]
      }
    ],

    "PostToolUse": [
      {
        "matcher": "mcp__bitbucket__create_pull_request|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/on-pr-created.sh",
            "timeout": 15
          }
        ]
      },
      {
        "matcher": "mcp__github__.*|gh pr create.*",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/on-github-action.sh",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

#### Hook Scripts

**`.claude/hooks/on-session-stop.sh`** - Capture state when session ends:
```bash
#!/bin/bash
# Receives JSON via stdin with session_id, transcript_path, etc.

set -e

# Read hook input
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path')
CWD=$(echo "$INPUT" | jq -r '.cwd')

# State directory
STATE_DIR="$HOME/.oss-agent/sessions"
mkdir -p "$STATE_DIR"

# Check if this session created a PR (scan last few messages)
PR_URL=$(jq -r '
  .messages[-10:] |
  .[] |
  select(.content | test("github.com/.*/pull/[0-9]+|bitbucket.org/.*/pull-requests/[0-9]+")) |
  .content |
  match("https://[^\\s]+/(pull|pull-requests)/[0-9]+") |
  .string
' "$TRANSCRIPT_PATH" 2>/dev/null | tail -1)

if [ -n "$PR_URL" ]; then
  # Session created a PR - save for feedback monitoring
  cat > "$STATE_DIR/$SESSION_ID.json" << EOF
{
  "session_id": "$SESSION_ID",
  "transcript_path": "$TRANSCRIPT_PATH",
  "cwd": "$CWD",
  "pr_url": "$PR_URL",
  "status": "awaiting_feedback",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "iterations": 0
}
EOF

  # Register with feedback monitor
  curl -s -X POST "${OSS_AGENT_API:-http://localhost:3000}/api/watch-pr" \
    -H "Content-Type: application/json" \
    -d "{\"session_id\": \"$SESSION_ID\", \"pr_url\": \"$PR_URL\"}" \
    || true  # Don't fail if monitor not running

  echo "Session $SESSION_ID saved for PR feedback monitoring: $PR_URL"
fi
```

**`.claude/hooks/on-session-start.sh`** - Inject feedback context on resume:
```bash
#!/bin/bash
# Output goes to Claude's context when resuming

set -e

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
SOURCE=$(echo "$INPUT" | jq -r '.source')  # "startup", "resume", "clear", "compact"

STATE_DIR="$HOME/.oss-agent/sessions"
STATE_FILE="$STATE_DIR/$SESSION_ID.json"

# Only inject context on resume (not fresh starts)
if [ "$SOURCE" = "resume" ] && [ -f "$STATE_FILE" ]; then
  STATUS=$(jq -r '.status' "$STATE_FILE")
  PR_URL=$(jq -r '.pr_url' "$STATE_FILE")

  if [ "$STATUS" = "has_feedback" ]; then
    FEEDBACK_FILE="$STATE_DIR/$SESSION_ID.feedback.json"

    if [ -f "$FEEDBACK_FILE" ]; then
      echo "=== PR FEEDBACK RECEIVED ==="
      echo ""
      echo "PR: $PR_URL"
      echo ""
      echo "The following feedback was received on your PR:"
      echo ""
      jq -r '.comments[] | "- [\(.author)]: \(.body)"' "$FEEDBACK_FILE"
      echo ""
      echo "Please address this feedback and push the changes."
      echo "=== END FEEDBACK ==="

      # Update state
      jq '.status = "iterating" | .iterations += 1' "$STATE_FILE" > "$STATE_FILE.tmp"
      mv "$STATE_FILE.tmp" "$STATE_FILE"
    fi
  fi
fi
```

**`.claude/hooks/on-pr-created.sh`** - React to PR creation:
```bash
#!/bin/bash
# Triggered after PR creation tools

set -e

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')
TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_output // empty')

# Extract PR URL from tool output
PR_URL=""

case "$TOOL_NAME" in
  "mcp__bitbucket__create_pull_request")
    PR_URL=$(echo "$TOOL_OUTPUT" | jq -r '.url // empty')
    ;;
  "Bash")
    # Check if it was a gh pr create command
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
    if echo "$COMMAND" | grep -q "gh pr create"; then
      PR_URL=$(echo "$TOOL_OUTPUT" | grep -oE 'https://github.com/[^/]+/[^/]+/pull/[0-9]+' | head -1)
    fi
    ;;
esac

if [ -n "$PR_URL" ]; then
  # Log PR creation
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) PR_CREATED $PR_URL" >> "$HOME/.oss-agent/pr-log.txt"

  # Could also trigger immediate actions here
  # e.g., send notification, update dashboard, etc.
fi
```

#### Feedback Monitor Service

A lightweight service that watches PRs and triggers session resumption:

```typescript
// feedback-monitor.ts
import { watch } from 'chokidar';
import { exec } from 'child_process';

interface WatchedPR {
  sessionId: string;
  prUrl: string;
  lastChecked: Date;
  platform: 'github' | 'bitbucket' | 'gitlab';
}

class FeedbackMonitor {
  private watched: Map<string, WatchedPR> = new Map();
  private checkInterval: NodeJS.Timeout;

  constructor(private config: MonitorConfig) {
    // Check for feedback every N minutes
    this.checkInterval = setInterval(
      () => this.checkAllPRs(),
      config.pollIntervalMs || 5 * 60 * 1000  // 5 min default
    );
  }

  async watchPR(sessionId: string, prUrl: string) {
    const platform = this.detectPlatform(prUrl);
    this.watched.set(sessionId, {
      sessionId,
      prUrl,
      lastChecked: new Date(),
      platform
    });
  }

  private async checkAllPRs() {
    for (const [sessionId, pr] of this.watched) {
      const feedback = await this.checkForFeedback(pr);

      if (feedback.hasNew) {
        await this.saveFeedback(sessionId, feedback);
        await this.triggerResume(sessionId, pr);
      }
    }
  }

  private async checkForFeedback(pr: WatchedPR): Promise<Feedback> {
    switch (pr.platform) {
      case 'github':
        return this.checkGitHubPR(pr);
      case 'bitbucket':
        return this.checkBitbucketPR(pr);
      default:
        throw new Error(`Unsupported platform: ${pr.platform}`);
    }
  }

  private async checkGitHubPR(pr: WatchedPR): Promise<Feedback> {
    // Use gh CLI or GitHub API
    const result = await exec(`gh pr view ${pr.prUrl} --json comments,reviews`);
    const data = JSON.parse(result.stdout);

    // Check for new comments since last check
    const newComments = data.comments.filter(
      (c: any) => new Date(c.createdAt) > pr.lastChecked
    );

    const newReviews = data.reviews.filter(
      (r: any) => new Date(r.submittedAt) > pr.lastChecked
    );

    return {
      hasNew: newComments.length > 0 || newReviews.length > 0,
      comments: [...newComments, ...newReviews],
      type: this.classifyFeedback(newComments, newReviews)
    };
  }

  private classifyFeedback(comments: any[], reviews: any[]): FeedbackType {
    // Check for automated feedback (Sourcery, CodeRabbit, etc.)
    const automatedAuthors = ['sourcery-ai[bot]', 'coderabbitai[bot]', 'github-actions[bot]'];
    const isAutomated = comments.some(c => automatedAuthors.includes(c.author));

    // Check for approval
    const hasApproval = reviews.some(r => r.state === 'APPROVED');

    // Check for change requests
    const hasChangeRequest = reviews.some(r => r.state === 'CHANGES_REQUESTED');

    if (hasApproval) return 'approved';
    if (hasChangeRequest) return 'changes_requested';
    if (isAutomated) return 'automated_feedback';
    return 'comment';
  }

  private async saveFeedback(sessionId: string, feedback: Feedback) {
    const feedbackPath = `${process.env.HOME}/.oss-agent/sessions/${sessionId}.feedback.json`;
    await fs.writeFile(feedbackPath, JSON.stringify(feedback, null, 2));

    // Update session state
    const statePath = `${process.env.HOME}/.oss-agent/sessions/${sessionId}.json`;
    const state = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    state.status = 'has_feedback';
    state.feedback_type = feedback.type;
    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  private async triggerResume(sessionId: string, pr: WatchedPR) {
    const state = await this.loadState(sessionId);

    // Check iteration limits
    if (state.iterations >= this.config.maxIterations) {
      console.log(`Session ${sessionId} has reached max iterations, skipping`);
      await this.notifyHuman(sessionId, 'Max iterations reached');
      return;
    }

    // Check budget
    if (!await this.budgetManager.canProceed('feedback_iteration', 2.0)) {
      console.log('Budget limit reached, skipping resume');
      return;
    }

    console.log(`Triggering resume for session ${sessionId}`);

    // Resume the Claude session
    exec(`cd "${state.cwd}" && claude --resume "${sessionId}"`, (err, stdout, stderr) => {
      if (err) {
        console.error(`Failed to resume session: ${err}`);
        this.notifyHuman(sessionId, `Resume failed: ${err.message}`);
      }
    });
  }
}
```

#### Alternative: Webhook-Based Triggering

For platforms with webhook support (GitHub, GitLab), use webhooks instead of polling:

```typescript
// webhook-handler.ts
import express from 'express';
import crypto from 'crypto';

const app = express();

app.post('/webhooks/github', express.json(), async (req, res) => {
  // Verify webhook signature
  const signature = req.headers['x-hub-signature-256'];
  const payload = JSON.stringify(req.body);
  const expected = `sha256=${crypto
    .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!)
    .update(payload)
    .digest('hex')}`;

  if (signature !== expected) {
    return res.status(401).send('Invalid signature');
  }

  const event = req.headers['x-github-event'];
  const { action, pull_request, comment, review } = req.body;

  // Handle PR review events
  if (event === 'pull_request_review' || event === 'pull_request_review_comment') {
    const prUrl = pull_request.html_url;
    const sessionId = await findSessionByPR(prUrl);

    if (sessionId) {
      // Save feedback and trigger resume
      await saveFeedback(sessionId, {
        type: event,
        author: review?.user?.login || comment?.user?.login,
        body: review?.body || comment?.body,
        state: review?.state
      });

      await triggerResume(sessionId);
    }
  }

  res.status(200).send('OK');
});

app.listen(3000);
```

#### Complete Hooks Workflow

```
1. User starts: oss-agent work-on-issue --issue 10569

2. Claude Code starts session
   └─▶ SessionStart hook runs
       └─▶ Checks for pending feedback (none on fresh start)

3. Claude analyzes issue, implements fix, creates PR
   └─▶ PostToolUse hook detects PR creation
       └─▶ Logs PR URL

4. Claude session completes
   └─▶ Stop hook runs
       └─▶ Saves session state with PR URL
       └─▶ Registers PR with feedback monitor

5. Time passes... Sourcery-AI comments on PR

6. Feedback monitor detects new comments
   └─▶ Saves feedback to session file
   └─▶ Updates session status to "has_feedback"
   └─▶ Runs: claude --resume <session_id>

7. Claude Code resumes session
   └─▶ SessionStart hook runs
       └─▶ Detects resume with feedback
       └─▶ Injects feedback context into conversation
       └─▶ Claude sees: "PR FEEDBACK RECEIVED: ..."

8. Claude addresses feedback, pushes changes

9. Stop hook runs again
   └─▶ Updates iteration count
   └─▶ Continues monitoring

10. Repeat until merged or max iterations reached
```

---

## Deployment Modes

### Mode 1: Local (CLI-based)

**Best for**: Development, testing, occasional use

```yaml
# config.local.yaml
mode: local

ai:
  provider: claude
  useClaudeCode: true  # Use claude CLI directly

mcp:
  transport: stdio
  servers:
    github:
      command: npx
      args: ["-y", "@anthropic/mcp-server-github"]
    bitbucket:
      command: python
      args: ["-m", "bitbucket_mcp"]

storage:
  type: sqlite
  path: ~/.oss-agent/state.db

schedule:
  enabled: false  # Manual trigger only
```

**Running locally**:
```bash
# Start the agent
oss-agent start

# Or run specific commands
oss-agent discover-projects
oss-agent find-issues --project python-poetry/poetry
oss-agent work-on-issue --issue 10569
oss-agent check-feedback --pr 10654
```

### Mode 2: Deployed (Render/Vercel)

**Best for**: Continuous operation, scheduled runs

```yaml
# config.deployed.yaml
mode: deployed

ai:
  provider: auto  # Claude if ANTHROPIC_API_KEY, else Gemini

  claude:
    model: claude-sonnet-4-5
    maxBudgetPerIssue: 5

  gemini:
    model: gemini-1.5-pro
    enabled: ${ANTHROPIC_API_KEY:-true}  # Enable if no Claude key

mcp:
  transport: mixed
  servers:
    # Remote MCP servers
    github:
      type: sse
      url: ${GITHUB_MCP_URL}

    # SDK servers (in-process)
    custom:
      type: sdk

  # Bridge for stdio MCPs (optional sidecar)
  stdioBridge:
    enabled: true
    endpoint: http://localhost:3001

storage:
  type: postgres
  url: ${DATABASE_URL}

  # Or Redis for simpler state
  redis:
    url: ${REDIS_URL}

schedule:
  # Cron-based scheduling
  projectDiscovery: "0 0 * * *"      # Daily at midnight
  issueScanning: "0 */4 * * *"       # Every 4 hours
  feedbackCheck: "*/30 * * * *"      # Every 30 minutes

webhooks:
  # GitHub webhook for instant feedback
  github:
    endpoint: /webhooks/github
    secret: ${GITHUB_WEBHOOK_SECRET}
    events:
      - pull_request_review
      - pull_request_review_comment
      - check_run
      - check_suite

api:
  # Control API
  port: 3000
  endpoints:
    - GET /status
    - POST /pause
    - POST /resume
    - GET /budget
    - POST /config
```

### Mode 3: Hybrid (Local + Deployed)

**Best for**: Best of both worlds

```yaml
# config.hybrid.yaml
mode: hybrid

# Local component: Heavy AI work
local:
  enabled: true
  triggers:
    # Poll deployed service for work
    pollEndpoint: ${DEPLOYED_URL}/api/queue
    pollInterval: 60000  # 1 minute

  ai:
    provider: claude
    useClaudeCode: true

  mcp:
    transport: stdio

# Deployed component: Monitoring, scheduling, webhooks
deployed:
  url: ${DEPLOYED_URL}

  responsibilities:
    - projectDiscovery
    - issueScanning
    - feedbackMonitoring
    - webhookHandling
    - stateManagement

  # Lightweight AI for triage only
  ai:
    provider: gemini
    model: gemini-1.5-flash
    maxBudgetPerOperation: 0.10
```

---

## Credential & Authentication Management

### Overview

The system needs credentials for:
1. **Git platforms** - GitHub, GitLab, Bitbucket (for API access, PRs)
2. **AI providers** - Anthropic (Claude), Google (Gemini)
3. **Optional services** - Slack, Discord, email notifications

### Credential Configuration

```typescript
interface CredentialsConfig {
  // How credentials are provided
  mode: "local" | "environment" | "oauth" | "vault";

  // Git platform credentials
  git: {
    github: GitHubCredentials;
    gitlab?: GitLabCredentials;
    bitbucket?: BitbucketCredentials;
  };

  // AI provider credentials
  ai: {
    anthropic?: AnthropicCredentials;
    google?: GoogleCredentials;
  };

  // Notification services (optional)
  notifications?: {
    slack?: { webhookUrl: string };
    discord?: { webhookUrl: string };
    email?: { smtpConfig: SMTPConfig };
  };
}

interface GitHubCredentials {
  // Authentication method
  method: "cli" | "token" | "oauth" | "app";

  // For "cli" mode: use gh CLI's existing auth
  // (gh auth login stores token in system keychain)
  useCli: boolean;

  // For "token" mode: personal access token
  token?: string;                     // Or use GITHUB_TOKEN env var

  // For "oauth" mode: OAuth app credentials (deployed)
  oauth?: {
    clientId: string;
    clientSecret: string;
    scopes: string[];                 // ["repo", "read:user"]
  };

  // For "app" mode: GitHub App (deployed, better rate limits)
  app?: {
    appId: string;
    privateKey: string;
    installationId: string;
  };
}

interface AnthropicCredentials {
  // API key (or use ANTHROPIC_API_KEY env var)
  apiKey?: string;

  // For future: OAuth with Anthropic Console
  oauth?: {
    enabled: boolean;
    clientId: string;
  };
}

interface GoogleCredentials {
  // For Gemini API
  apiKey?: string;                    // Or use GOOGLE_API_KEY env var

  // For Vertex AI
  vertexAi?: {
    projectId: string;
    location: string;
    // Uses ADC (Application Default Credentials)
  };

  // For future: Sign in with Google
  oauth?: {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
  };
}
```

### Local Mode (CLI)

In local mode, leverage existing CLI authentications:

```yaml
# config.local.yaml
credentials:
  mode: local

  git:
    github:
      method: cli        # Uses gh auth (already logged in)
      useCli: true

    bitbucket:
      method: token
      # Token from environment: BITBUCKET_TOKEN
      # Or from .netrc file

  ai:
    anthropic:
      # Uses ANTHROPIC_API_KEY from environment
      # If not set, falls back to Gemini
    google:
      # Uses GOOGLE_API_KEY from environment
```

**Setup commands for local mode**:
```bash
# GitHub - uses system keychain
gh auth login

# Verify GitHub auth
gh auth status

# Set AI keys in shell profile (~/.zshrc or ~/.bashrc)
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_API_KEY="AIza..."

# Or use a .env file (not committed)
echo "ANTHROPIC_API_KEY=sk-ant-..." >> ~/.oss-agent/.env
echo "GOOGLE_API_KEY=AIza..." >> ~/.oss-agent/.env

# Bitbucket (if needed)
export BITBUCKET_USERNAME="your-username"
export BITBUCKET_APP_PASSWORD="your-app-password"
```

### Deployed Mode (Environment Variables)

For Render, Vercel, or other platforms:

```yaml
# config.deployed.yaml
credentials:
  mode: environment

  git:
    github:
      method: token
      # Set GITHUB_TOKEN in platform's environment variables

    bitbucket:
      method: token
      # Set BITBUCKET_TOKEN in platform's environment variables

  ai:
    anthropic:
      # Set ANTHROPIC_API_KEY in platform's environment variables
    google:
      # Set GOOGLE_API_KEY as fallback
```

**Required environment variables**:
```bash
# Required
GITHUB_TOKEN=ghp_...              # GitHub Personal Access Token

# AI (at least one required)
ANTHROPIC_API_KEY=sk-ant-...      # Primary
GOOGLE_API_KEY=AIza...            # Fallback

# Optional
BITBUCKET_TOKEN=...
GITLAB_TOKEN=...
GITHUB_WEBHOOK_SECRET=...         # For webhook verification
```

### Future: OAuth Sign-In (Phase 5+)

For a full SaaS experience, support OAuth sign-in:

```typescript
interface OAuthConfig {
  providers: {
    // Sign in with GitHub
    github: {
      enabled: boolean;
      clientId: string;
      clientSecret: string;
      scopes: ["read:user", "repo", "write:repo_hook"];
      // Grants: repository access, webhook creation
    };

    // Sign in with Google
    google: {
      enabled: boolean;
      clientId: string;
      clientSecret: string;
      scopes: ["email", "profile"];
      // Can also link to Vertex AI access
    };

    // Sign in with Anthropic (future)
    anthropic: {
      enabled: boolean;
      clientId: string;
      // Grants: Claude API access with user's billing
    };
  };

  // Session management
  session: {
    secret: string;
    maxAge: number;               // Session duration
    storage: "cookie" | "redis";
  };
}
```

**OAuth Flow**:
```
┌─────────────────────────────────────────────────────────────────┐
│                     OAuth Sign-In Flow                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   User clicks "Sign in with GitHub"                             │
│                    │                                             │
│                    ▼                                             │
│   ┌─────────────────────────────────┐                           │
│   │  GitHub OAuth Authorization     │                           │
│   │  - Repo access (public/private) │                           │
│   │  - Webhook creation             │                           │
│   │  - User profile                 │                           │
│   └─────────────────────────────────┘                           │
│                    │                                             │
│                    ▼                                             │
│   Token stored securely (encrypted in DB)                       │
│                    │                                             │
│                    ▼                                             │
│   Agent can now:                                                 │
│   - Access user's repos                                          │
│   - Create PRs as user                                           │
│   - Set up webhooks for feedback                                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**User data model (future)**:
```typescript
interface User {
  id: string;
  email: string;

  // Connected accounts
  connections: {
    github?: {
      id: string;
      username: string;
      accessToken: string;          // Encrypted
      refreshToken?: string;
      scopes: string[];
      connectedAt: Date;
    };

    google?: {
      id: string;
      email: string;
      accessToken: string;
      connectedAt: Date;
    };

    anthropic?: {
      id: string;
      accessToken: string;
      // Uses user's Anthropic billing
      connectedAt: Date;
    };
  };

  // User preferences
  preferences: {
    defaultProjects: string[];
    discoveryConfig: ProjectDiscoveryConfig;
    budgetLimits: BudgetConfig;
    notifications: NotificationPrefs;
  };

  // Usage tracking
  usage: {
    totalSpent: number;
    issuesWorked: number;
    prsMerged: number;
    currentPeriodSpent: number;
  };
}
```

### Credential Priority Resolution

The system resolves credentials in this order:

```typescript
function resolveCredentials(config: CredentialsConfig): ResolvedCredentials {
  // 1. Explicit config values (highest priority)
  // 2. Environment variables
  // 3. CLI tools (gh auth, gcloud auth)
  // 4. OAuth tokens from database
  // 5. Vault/secrets manager

  const github = resolveGitHub(config.git.github);
  const ai = resolveAI(config.ai);

  return { github, ai };
}

function resolveGitHub(config: GitHubCredentials): string {
  // Priority order:
  if (config.token) return config.token;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (config.useCli) return getGhCliToken();  // gh auth token
  if (config.oauth) return getOAuthToken('github');
  throw new Error('No GitHub credentials available');
}

function resolveAI(config: AICredentials): AIProvider {
  // Try Claude first
  const anthropicKey = config.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return new ClaudeProvider(anthropicKey);
  }

  // Fall back to Gemini
  const googleKey = config.google?.apiKey || process.env.GOOGLE_API_KEY;
  if (googleKey) {
    return new GeminiProvider(googleKey);
  }

  throw new Error('No AI provider credentials available');
}
```

### Security Best Practices

```typescript
const securityConfig = {
  // Never log credentials
  logging: {
    redactPatterns: [
      /ghp_[a-zA-Z0-9]+/g,           // GitHub tokens
      /sk-ant-[a-zA-Z0-9]+/g,        // Anthropic keys
      /AIza[a-zA-Z0-9]+/g,           // Google keys
    ]
  },

  // Encrypt at rest
  encryption: {
    algorithm: "aes-256-gcm",
    keySource: "env:ENCRYPTION_KEY"   // Or KMS
  },

  // Token rotation
  rotation: {
    enabled: true,
    maxAge: "90d",                    // Rotate tokens every 90 days
    notifyBefore: "7d"                // Warn user 7 days before
  },

  // Scope minimization
  scopes: {
    github: {
      minimum: ["public_repo"],       // For public repos only
      full: ["repo", "write:repo_hook"] // For private repos + webhooks
    }
  }
};
```

---

## Control Interface

### CLI Commands

```bash
# System control
oss-agent pause                      # Pause all operations
oss-agent resume                     # Resume operations
oss-agent status                     # Show current status
oss-agent budget                     # Show budget status

# Project management
oss-agent projects list              # List tracked projects
oss-agent projects add <url>         # Add project manually
oss-agent projects remove <url>      # Stop tracking project
oss-agent projects scan              # Force project discovery

# Issue management
oss-agent issues list                # List issues in queue
oss-agent issues add <url>           # Add issue manually
oss-agent issues skip <id>           # Skip an issue
oss-agent issues prioritize <id>     # Move to front of queue

# PR management
oss-agent prs list                   # List active PRs
oss-agent prs check <url>            # Force feedback check
oss-agent prs abandon <url>          # Abandon a PR

# Configuration
oss-agent config show                # Show current config
oss-agent config set <key> <value>   # Update config
oss-agent config limits              # Show/set limits
```

### Web Dashboard (Deployed Mode)

```
┌─────────────────────────────────────────────────────────────────┐
│  OSS Contribution Agent Dashboard                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Status: ● Running          Budget: $12.50 / $50.00 (25%)       │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Active Work                                                 ││
│  │ ├─ python-poetry/poetry#10569 [In Progress] - 3 turns      ││
│  │ └─ astral-sh/ruff#4521 [Awaiting Feedback]                 ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Queue (5 issues)                                            ││
│  │ 1. fastapi/fastapi#9823 - Score: 85                        ││
│  │ 2. pydantic/pydantic#7234 - Score: 78                      ││
│  │ ...                                                         ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  [Pause] [Add Issue] [Refresh] [Settings]                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Core Engine (MVP)

**Goal**: Work on manually specified issues

- [ ] AI provider abstraction (Claude + Gemini fallback)
- [ ] Basic contribution workflow (understand → implement → submit)
- [ ] GitHub MCP integration
- [ ] Budget tracking (simple)
- [ ] CLI interface
- [ ] SQLite state persistence

**Estimated time**: 2-3 weeks

### Phase 2: Feedback Loop

**Goal**: Handle PR feedback automatically

- [ ] PR monitoring service
- [ ] Feedback detection (automated + human)
- [ ] Iteration workflow
- [ ] Webhook support (GitHub)
- [ ] Notification system

**Estimated time**: 2 weeks

### Phase 3: Discovery & Queue

**Goal**: Automatic project/issue discovery

- [ ] Project discovery service
- [ ] Issue selection & scoring
- [ ] Queue management
- [ ] Scheduling system

**Estimated time**: 2 weeks

### Phase 4: Deployment & Scaling

**Goal**: Production-ready deployment

- [ ] Render/Vercel deployment
- [ ] PostgreSQL/Redis state
- [ ] Web dashboard
- [ ] Multi-platform support (GitLab, Bitbucket)
- [ ] Hybrid mode

### Phase 5: User Management & OAuth

**Goal**: Multi-user SaaS experience

- [ ] OAuth sign-in (GitHub, Google, Anthropic)
- [ ] User preferences and settings
- [ ] Per-user budget tracking
- [ ] Team/organization support

### Phase 6: Proactive Issue Discovery (Advanced)

**Goal**: AI-powered code auditing to discover and create issues

- [ ] Codebase audit engine
- [ ] Issue generation and validation
- [ ] Responsible disclosure workflow
- [ ] Maintainer notification system

---

## Proactive Issue Discovery (Phase 6+)

### Vision: From Reactive to Proactive

Instead of only working on existing issues, the agent can **proactively audit codebases** to find problems and create well-documented issues. This transforms the agent from a "contributor" to a "code health partner."

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Proactive Contribution Model                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Traditional Model (Reactive):                                              │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐            │
│   │ Maintainer│───▶│  Issue   │───▶│  Agent   │───▶│   PR     │            │
│   │creates    │    │  exists  │    │  works   │    │ created  │            │
│   │ issue     │    │          │    │          │    │          │            │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘            │
│                                                                              │
│   Proactive Model:                                                           │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐            │
│   │  Agent   │───▶│  Agent   │───▶│ Maintainer│───▶│  Agent   │            │
│   │  audits  │    │ creates  │    │ approves │    │  fixes   │            │
│   │  code    │    │  issue   │    │  issue   │    │  issue   │            │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Audit Categories

```typescript
interface CodeAuditConfig {
  // What to audit
  categories: {
    // Security vulnerabilities
    security: {
      enabled: boolean;
      checks: [
        "sql_injection",
        "xss",
        "path_traversal",
        "insecure_deserialization",
        "hardcoded_secrets",
        "dependency_vulnerabilities",
        "authentication_flaws",
        "authorization_bypass"
      ];
      severity: "critical" | "high" | "medium" | "all";
    };

    // Code quality issues
    quality: {
      enabled: boolean;
      checks: [
        "code_smells",
        "duplicated_code",
        "complex_functions",
        "missing_error_handling",
        "inconsistent_naming",
        "dead_code",
        "magic_numbers"
      ];
    };

    // Performance issues
    performance: {
      enabled: boolean;
      checks: [
        "n_plus_one_queries",
        "missing_indexes",
        "memory_leaks",
        "inefficient_algorithms",
        "blocking_operations",
        "missing_caching"
      ];
    };

    // Documentation gaps
    documentation: {
      enabled: boolean;
      checks: [
        "missing_docstrings",
        "outdated_readme",
        "missing_api_docs",
        "undocumented_config",
        "missing_examples"
      ];
    };

    // Testing gaps
    testing: {
      enabled: boolean;
      checks: [
        "low_coverage_areas",
        "missing_edge_cases",
        "flaky_tests",
        "missing_integration_tests",
        "untested_error_paths"
      ];
    };

    // Dependency health
    dependencies: {
      enabled: boolean;
      checks: [
        "outdated_packages",
        "deprecated_apis",
        "license_issues",
        "unmaintained_deps",
        "version_conflicts"
      ];
    };
  };

  // Audit behavior
  behavior: {
    // How thorough to be
    depth: "quick" | "standard" | "deep";

    // Max issues to create per audit
    maxIssuesPerAudit: number;

    // Min confidence to report
    minConfidence: number;  // 0.0 - 1.0

    // Require human review before creating issue
    requireReviewBeforeCreating: boolean;
  };
}
```

### Audit Engine Implementation

```typescript
// audit-engine.ts
import { query } from "@anthropic-ai/claude-agent-sdk";

interface AuditResult {
  category: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  confidence: number;
  title: string;
  description: string;
  location: {
    file: string;
    startLine: number;
    endLine: number;
  };
  evidence: string;
  suggestedFix?: string;
  references?: string[];
}

async function auditCodebase(
  repoPath: string,
  config: CodeAuditConfig
): Promise<AuditResult[]> {

  const auditPrompt = `
You are a code auditor. Analyze this codebase for issues.

## Audit Configuration
${JSON.stringify(config.categories, null, 2)}

## Instructions

1. First, understand the project structure and purpose
2. For each enabled category, systematically review the code
3. For each issue found:
   - Verify it's a real issue (not a false positive)
   - Assess severity and confidence
   - Provide specific file locations and line numbers
   - Write a clear, actionable description
   - Suggest a fix if possible

4. Prioritize:
   - Security issues (especially critical/high)
   - Issues that are easy to fix but high impact
   - Issues that affect many users

5. Skip:
   - Style-only issues (leave for linters)
   - Highly subjective issues
   - Issues already tracked in existing GitHub issues

## Output Format
Return a JSON array of issues found, each with:
- category, severity, confidence (0-1)
- title (concise, like a good issue title)
- description (detailed, with context)
- location (file, startLine, endLine)
- evidence (code snippet showing the issue)
- suggestedFix (if applicable)
- references (CVEs, docs, etc.)

Be thorough but precise. Quality over quantity.
`;

  const result = await query({
    prompt: auditPrompt,
    options: {
      model: "claude-opus-4-5-20251101",  // Use best model for security
      allowedTools: ["Read", "Glob", "Grep", "Bash", "WebSearch"],
      maxTurns: 50,
      maxBudgetUsd: 10.0,  // Audits are expensive but valuable
      cwd: repoPath,
      outputFormat: {
        type: "json_schema",
        schema: auditResultSchema
      }
    }
  });

  return parseAuditResults(result);
}
```

### Issue Generation

```typescript
interface GeneratedIssue {
  // Issue content
  title: string;
  body: string;
  labels: string[];

  // Metadata
  audit: AuditResult;
  confidence: number;

  // Review status
  status: "pending_review" | "approved" | "rejected" | "created";
  reviewedBy?: string;
  reviewNotes?: string;
}

function generateIssueFromAudit(audit: AuditResult): GeneratedIssue {
  const labels = determineLabels(audit);
  const body = formatIssueBody(audit);

  return {
    title: audit.title,
    body,
    labels,
    audit,
    confidence: audit.confidence,
    status: "pending_review"
  };
}

function formatIssueBody(audit: AuditResult): string {
  return `
## Summary

${audit.description}

## Location

\`${audit.location.file}\` (lines ${audit.location.startLine}-${audit.location.endLine})

## Evidence

\`\`\`
${audit.evidence}
\`\`\`

${audit.suggestedFix ? `
## Suggested Fix

${audit.suggestedFix}
` : ''}

${audit.references?.length ? `
## References

${audit.references.map(r => `- ${r}`).join('\n')}
` : ''}

---

<details>
<summary>Audit Metadata</summary>

- **Category**: ${audit.category}
- **Severity**: ${audit.severity}
- **Confidence**: ${(audit.confidence * 100).toFixed(0)}%
- **Discovered by**: Automated code audit

</details>

🤖 *This issue was discovered by automated code analysis. Please verify before acting.*
`;
}

function determineLabels(audit: AuditResult): string[] {
  const labels: string[] = [];

  // Category label
  labels.push(audit.category);

  // Severity label
  if (audit.severity === "critical" || audit.severity === "high") {
    labels.push("priority:high");
  }

  // Type labels
  if (audit.category === "security") {
    labels.push("security");
  }
  if (audit.category === "documentation") {
    labels.push("documentation");
  }

  // Good first issue for simple fixes
  if (audit.confidence > 0.9 && audit.suggestedFix && isSimpleFix(audit)) {
    labels.push("good first issue");
  }

  return labels;
}
```

### Responsible Disclosure Workflow

For security issues, follow responsible disclosure:

```typescript
interface SecurityDisclosureConfig {
  // For critical/high security issues
  security: {
    // Don't create public issues for security vulnerabilities
    createPublicIssue: false;

    // Instead, use security advisory or private report
    disclosureMethod: "security_advisory" | "private_email" | "security_txt";

    // Wait period before public disclosure
    disclosurePeriodDays: 90;

    // Escalation if no response
    escalation: {
      enabled: boolean;
      afterDays: 30;
      method: "public_issue" | "cve_request";
    };
  };

  // For non-security issues
  nonSecurity: {
    createPublicIssue: true;
    requireMaintainerApproval: boolean;  // Optional: wait for thumbs up
  };
}

async function discloseSecurity(
  repo: string,
  audit: AuditResult,
  config: SecurityDisclosureConfig
): Promise<void> {

  if (audit.category === "security" &&
      (audit.severity === "critical" || audit.severity === "high")) {

    // Use GitHub Security Advisory (private)
    if (config.security.disclosureMethod === "security_advisory") {
      await createSecurityAdvisory(repo, {
        summary: audit.title,
        description: audit.description,
        severity: mapToGitHubSeverity(audit.severity),
        vulnerabilities: [{
          package: extractPackage(audit),
          vulnerable_version_range: "*",
          patched_versions: null
        }]
      });

      console.log(`Security advisory created for ${repo}`);
      return;
    }

    // Check for SECURITY.md or security.txt
    const securityContact = await findSecurityContact(repo);
    if (securityContact) {
      await sendPrivateReport(securityContact, audit);
      return;
    }

    // Fallback: private email to maintainers
    const maintainers = await getMaintainerEmails(repo);
    await sendSecurityEmail(maintainers, audit);

  } else {
    // Non-security issue: create public issue
    await createGitHubIssue(repo, generateIssueFromAudit(audit));
  }
}
```

### Human Review Interface

Before creating issues, allow human review:

```typescript
interface ReviewQueue {
  // Pending issues awaiting review
  pending: GeneratedIssue[];

  // Review actions
  actions: {
    approve: (issueId: string) => Promise<void>;
    reject: (issueId: string, reason: string) => Promise<void>;
    edit: (issueId: string, changes: Partial<GeneratedIssue>) => Promise<void>;
    createNow: (issueId: string) => Promise<string>;  // Returns issue URL
  };
}

// CLI review interface
async function reviewPendingIssues(): Promise<void> {
  const pending = await getReviewQueue();

  for (const issue of pending) {
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 Issue: ${issue.title}
📁 Location: ${issue.audit.location.file}:${issue.audit.location.startLine}
🏷️  Category: ${issue.audit.category} | Severity: ${issue.audit.severity}
📊 Confidence: ${(issue.confidence * 100).toFixed(0)}%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${issue.body}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[A]pprove  [R]eject  [E]dit  [S]kip  [Q]uit
`);

    const action = await prompt("Action: ");
    // Handle action...
  }
}
```

### Audit Scheduling

```yaml
# Audit configuration
audit:
  enabled: true

  # Schedule
  schedule:
    # Full audit monthly
    full: "0 0 1 * *"
    # Quick security scan weekly
    security: "0 0 * * 0"

  # Per-project settings
  projects:
    - repo: python-poetry/poetry
      categories:
        security: { enabled: true, severity: high }
        quality: { enabled: true }
        testing: { enabled: false }  # Skip for this project

    - repo: my-org/internal-tool
      categories:
        security: { enabled: true, severity: all }  # More thorough
        dependencies: { enabled: true }

  # Global limits
  limits:
    maxIssuesPerProject: 5
    maxIssuesPerWeek: 20
    requireReview: true
```

### Self-Resolution: Fixing Issues You Create

The natural extension is for the agent to **fix the issues it discovers**:

```typescript
interface SelfResolutionConfig {
  enabled: boolean;

  // When to auto-fix
  autoFix: {
    // Only auto-fix issues with suggested fixes
    requireSuggestedFix: boolean;

    // Minimum confidence to auto-fix without review
    minConfidenceForAutoFix: number;  // e.g., 0.95

    // Categories allowed for auto-fix
    allowedCategories: string[];  // e.g., ["documentation", "testing", "quality"]

    // Never auto-fix security (always needs review)
    neverAutoFix: ["security"];
  };

  // Workflow options
  workflow: {
    // Create issue first, then PR that references it
    // vs. Create PR directly with issue description in body
    mode: "issue_then_pr" | "pr_only" | "ask_maintainer";

    // Wait for issue to be acknowledged before fixing
    waitForAck: boolean;
    waitPeriodHours: number;  // e.g., 48 hours

    // If maintainer rejects issue, don't attempt fix
    respectRejection: boolean;
  };

  // For own projects (user's repos)
  ownProjects: {
    // More aggressive auto-fix for your own repos
    autoMerge: boolean;
    skipIssueCreation: boolean;  // Just create PR directly
    runCIBeforeMerge: boolean;
  };
}
```

#### Full Audit-to-Fix Workflow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Complete Proactive Contribution Flow                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐                                                        │
│  │  1. AUDIT        │  Agent audits codebase                                 │
│  │     CODEBASE     │  - Security, quality, docs, tests                     │
│  └────────┬─────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌──────────────────┐                                                        │
│  │  2. GENERATE     │  For each finding:                                     │
│  │     ISSUES       │  - Create detailed issue                              │
│  │                  │  - Include evidence + suggested fix                   │
│  └────────┬─────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌──────────────────┐    ┌──────────────────┐                               │
│  │  3. REVIEW       │───▶│  Human approves  │                               │
│  │     QUEUE        │    │  or rejects      │                               │
│  └────────┬─────────┘    └──────────────────┘                               │
│           │ (approved)                                                       │
│           ▼                                                                  │
│  ┌──────────────────┐                                                        │
│  │  4. CREATE       │  Post issue to GitHub                                  │
│  │     ISSUE        │  - Labels, assignee (self)                            │
│  └────────┬─────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌──────────────────┐    ┌──────────────────┐                               │
│  │  5. WAIT FOR     │───▶│  Maintainer:     │                               │
│  │     ACK          │    │  👍 = proceed    │                               │
│  │  (configurable)  │    │  👎 = skip       │                               │
│  └────────┬─────────┘    │  💬 = discuss    │                               │
│           │              └──────────────────┘                               │
│           ▼                                                                  │
│  ┌──────────────────┐                                                        │
│  │  6. IMPLEMENT    │  Agent implements fix                                  │
│  │     FIX          │  - Uses suggested fix as starting point              │
│  │                  │  - Adds tests if needed                               │
│  └────────┬─────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌──────────────────┐                                                        │
│  │  7. CREATE PR    │  PR references issue: "Fixes #123"                    │
│  │                  │  - Auto-links to issue                                │
│  │                  │  - CI runs                                             │
│  └────────┬─────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌──────────────────┐                                                        │
│  │  8. FEEDBACK     │  Standard feedback loop                                │
│  │     LOOP         │  - Address review comments                            │
│  │                  │  - Iterate until merged                               │
│  └──────────────────┘                                                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Configuration Examples

```yaml
# Conservative: Always create issue first, wait for acknowledgment
selfResolution:
  enabled: true
  autoFix:
    requireSuggestedFix: true
    minConfidenceForAutoFix: 0.98
    allowedCategories: [documentation]
    neverAutoFix: [security, performance]
  workflow:
    mode: issue_then_pr
    waitForAck: true
    waitPeriodHours: 72
    respectRejection: true

# Moderate: Create issues but don't wait
selfResolution:
  enabled: true
  autoFix:
    requireSuggestedFix: true
    minConfidenceForAutoFix: 0.90
    allowedCategories: [documentation, testing, quality]
    neverAutoFix: [security]
  workflow:
    mode: issue_then_pr
    waitForAck: false
    respectRejection: true

# Aggressive (own projects): Auto-fix and auto-merge
selfResolution:
  enabled: true
  ownProjects:
    autoMerge: true
    skipIssueCreation: true
    runCIBeforeMerge: true
  autoFix:
    minConfidenceForAutoFix: 0.85
    allowedCategories: [documentation, testing, quality, dependencies]
```

#### Connecting to Existing Issue Queue

Issues created by audit flow into the standard contribution queue:

```typescript
async function processAuditResult(audit: AuditResult, config: SelfResolutionConfig) {
  // Generate issue from audit
  const issue = generateIssueFromAudit(audit);

  // Add to review queue (or skip if auto-approved)
  if (config.autoFix.minConfidenceForAutoFix <= audit.confidence &&
      config.autoFix.allowedCategories.includes(audit.category)) {
    issue.status = "approved";  // Auto-approve high-confidence issues
  }

  // After review/approval, create on GitHub
  if (issue.status === "approved") {
    const createdIssue = await createGitHubIssue(audit.repo, issue);

    // Wait for acknowledgment if configured
    if (config.workflow.waitForAck) {
      await waitForReaction(createdIssue.url, config.workflow.waitPeriodHours);
    }

    // Add to contribution queue (standard issue workflow)
    await addToQueue({
      source: "self_audit",
      issueUrl: createdIssue.url,
      priority: calculatePriority(audit),
      context: {
        auditResult: audit,
        suggestedFix: audit.suggestedFix
      }
    });
  }
}
```

This creates a **complete cycle**: Audit → Issue → Fix → PR → Merge → Repeat

### Ethical Considerations for Proactive Auditing

```typescript
const proactiveEthics = {
  // Consent and transparency
  consent: {
    // Only audit projects that welcome it
    requireContributingGuide: true,

    // Check if project accepts automated issues
    checkIssueTemplates: true,

    // Disclose AI-generated nature
    discloseAutomation: true,
  },

  // Quality over quantity
  quality: {
    // High confidence threshold
    minConfidence: 0.85,

    // Require human review for first N issues per project
    reviewFirstN: 3,

    // Don't spam projects
    maxIssuesPerProject: 5,
    cooldownDays: 30,
  },

  // Security responsibility
  security: {
    // Never disclose vulnerabilities publicly without process
    followResponsibleDisclosure: true,

    // Give maintainers time to respond
    waitPeriodDays: 90,

    // Don't create exploit code
    neverGenerateExploits: true,
  },

  // Avoid noise
  noise: {
    // Skip if similar issue exists
    checkExistingIssues: true,

    // Skip trivial issues
    skipTrivial: true,

    // Combine related issues
    groupRelatedIssues: true,
  }
};
```

---

## Safety & Ethics Considerations

### Contribution Ethics

```typescript
const ethicsConfig = {
  // Never do
  never: [
    "Claim issues that others are working on",
    "Submit low-quality PRs to farm contributions",
    "Spam projects with trivial changes",
    "Ignore maintainer feedback",
    "Work on security-sensitive code without disclosure"
  ],

  // Always do
  always: [
    "Respect project contribution guidelines",
    "Wait appropriate time before claiming issues",
    "Disclose AI-assisted nature in PR description",
    "Respond promptly to feedback",
    "Abandon PRs cleanly if not proceeding"
  ],

  // Configuration
  settings: {
    // Wait time before working on issue (avoid race conditions)
    issueClaimDelayDays: 3,

    // Disclose AI assistance
    disclosureText: "🤖 Generated with AI assistance",

    // Respect rate limits
    maxPRsPerProjectPerWeek: 2,

    // Quality gates
    requireTestsPass: true,
    requireLintPass: true,
    minCodeCoverage: null  // Project-dependent
  }
};
```

### Security Measures

```typescript
const securityConfig = {
  // File access restrictions
  fileAccess: {
    // Never read/write
    blocked: [
      "**/.env*",
      "**/secrets/**",
      "**/*.pem",
      "**/*.key",
      "**/credentials*"
    ],

    // Read-only
    readOnly: [
      "**/LICENSE*",
      "**/.git/**"
    ]
  },

  // Command restrictions
  commands: {
    blocked: [
      "rm -rf /",
      "curl | sh",
      "wget | bash"
    ],

    requireApproval: [
      "git push --force",
      "npm publish",
      "pip install"
    ]
  },

  // Network restrictions
  network: {
    allowedDomains: [
      "github.com",
      "api.github.com",
      "pypi.org",
      "npmjs.com"
    ]
  }
};
```

---

## Cost Estimation

### Per-Operation Costs (Claude Sonnet)

| Operation | Estimated Tokens | Estimated Cost |
|-----------|------------------|----------------|
| Issue analysis | 10K-30K | $0.10-0.30 |
| Implementation | 50K-200K | $0.50-2.00 |
| Tests + Lint | 20K-50K | $0.20-0.50 |
| PR creation | 5K-10K | $0.05-0.10 |
| Feedback iteration | 20K-50K | $0.20-0.50 |
| **Total per issue** | 100K-350K | **$1.00-3.50** |

### Monthly Budget Examples

| Level | Issues/Month | Budget |
|-------|--------------|--------|
| Hobby | 10-20 | $20-70 |
| Active | 50-100 | $100-350 |
| Heavy | 200+ | $400+ |

---

## File Structure

```
oss-contribution-agent/
├── src/
│   ├── core/
│   │   ├── agent.ts              # Main agent orchestrator
│   │   ├── workflow.ts           # Contribution workflow
│   │   └── session.ts            # Session management
│   │
│   ├── providers/
│   │   ├── interface.ts          # AI provider interface
│   │   ├── claude.ts             # Claude implementation
│   │   ├── gemini.ts             # Gemini implementation
│   │   └── factory.ts            # Provider factory
│   │
│   ├── services/
│   │   ├── discovery.ts          # Project discovery
│   │   ├── issues.ts             # Issue selection
│   │   ├── feedback.ts           # Feedback handling
│   │   └── notifications.ts      # Notifications
│   │
│   ├── mcp/
│   │   ├── manager.ts            # MCP server manager
│   │   ├── stdio-bridge.ts       # Stdio bridge for deployed
│   │   └── custom-tools.ts       # Custom SDK tools
│   │
│   ├── control/
│   │   ├── budget.ts             # Budget management
│   │   ├── rate-limiter.ts       # Rate limiting
│   │   ├── queue.ts              # Work queue
│   │   └── scheduler.ts          # Scheduled jobs
│   │
│   ├── storage/
│   │   ├── interface.ts          # Storage interface
│   │   ├── sqlite.ts             # SQLite (local)
│   │   ├── postgres.ts           # PostgreSQL (deployed)
│   │   └── redis.ts              # Redis (cache/state)
│   │
│   ├── api/
│   │   ├── server.ts             # HTTP API server
│   │   ├── webhooks.ts           # Webhook handlers
│   │   └── dashboard.ts          # Web dashboard
│   │
│   └── cli/
│       ├── index.ts              # CLI entry point
│       └── commands/             # CLI commands
│
├── config/
│   ├── default.yaml              # Default configuration
│   ├── local.yaml                # Local mode config
│   └── deployed.yaml             # Deployed mode config
│
├── mcp-servers/                  # Custom MCP servers
│   └── oss-tools/                # OSS-specific tools
│
├── docker/
│   ├── Dockerfile                # Main container
│   ├── Dockerfile.bridge         # Stdio bridge sidecar
│   └── docker-compose.yaml       # Local development
│
├── deploy/
│   ├── render.yaml               # Render blueprint
│   └── vercel.json               # Vercel config
│
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

---

## Next Steps

1. **Validate design**: Review this document and identify any gaps
2. **Choose initial scope**: Start with Phase 1 (Core Engine MVP)
3. **Set up project**: Create repo structure, CI/CD
4. **Implement provider layer**: Claude + Gemini abstraction
5. **Build contribution workflow**: The core agent logic
6. **Test on real issues**: Start with poetry or similar projects

Would you like me to start implementing any specific component?
