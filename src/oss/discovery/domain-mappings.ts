/**
 * Domain and Framework mappings for intelligent project discovery
 */

export interface DomainConfig {
  topics: string[];
  keywords: string[];
  frameworks: string[];
  curatedLists: string[];
}

export interface FrameworkConfig {
  topics: string[];
  keywords: string[];
  languages: string[];
}

/**
 * Pre-defined domain categories with associated topics and keywords
 */
export const DOMAIN_MAPPINGS: Record<string, DomainConfig> = {
  "ai-ml": {
    topics: [
      "machine-learning",
      "deep-learning",
      "artificial-intelligence",
      "nlp",
      "computer-vision",
    ],
    keywords: ["transformer", "neural", "model", "training", "inference"],
    frameworks: ["pytorch", "tensorflow", "keras", "huggingface", "langchain"],
    curatedLists: ["awesome-machine-learning", "awesome-deep-learning"],
  },

  cybersecurity: {
    topics: ["security", "pentesting", "vulnerability", "infosec", "devsecops"],
    keywords: ["scanner", "exploit", "audit", "compliance", "sast", "dast"],
    frameworks: ["burp", "metasploit", "nmap"],
    curatedLists: ["awesome-security", "awesome-hacking", "awesome-pentest"],
  },

  frontend: {
    topics: ["frontend", "ui", "react", "vue", "svelte", "web-components"],
    keywords: ["component", "design-system", "ui-kit", "styling"],
    frameworks: ["react", "vue", "svelte", "angular", "nextjs", "nuxt"],
    curatedLists: ["awesome-react", "awesome-vue", "awesome-svelte"],
  },

  devtools: {
    topics: ["developer-tools", "cli", "productivity", "automation"],
    keywords: ["linter", "formatter", "bundler", "compiler", "debugger"],
    frameworks: [],
    curatedLists: ["awesome-cli-apps", "awesome-devtools"],
  },

  backend: {
    topics: ["backend", "api", "server", "microservices", "database"],
    keywords: ["rest", "graphql", "grpc", "orm", "queue"],
    frameworks: ["fastapi", "django", "flask", "express", "nestjs", "actix"],
    curatedLists: ["awesome-fastapi", "awesome-django"],
  },

  data: {
    topics: ["data-engineering", "etl", "analytics", "visualization"],
    keywords: ["pipeline", "warehouse", "streaming", "batch"],
    frameworks: ["pandas", "spark", "dbt", "airflow", "dagster"],
    curatedLists: ["awesome-data-engineering", "awesome-etl"],
  },

  infrastructure: {
    topics: ["devops", "kubernetes", "docker", "terraform", "cloud"],
    keywords: ["container", "orchestration", "deployment", "ci-cd"],
    frameworks: ["kubernetes", "docker", "terraform", "ansible", "pulumi"],
    curatedLists: ["awesome-kubernetes", "awesome-docker", "awesome-terraform"],
  },

  testing: {
    topics: ["testing", "qa", "test-automation", "e2e-testing"],
    keywords: ["unittest", "integration", "e2e", "mock", "fixture"],
    frameworks: ["pytest", "jest", "playwright", "cypress", "selenium"],
    curatedLists: ["awesome-testing", "awesome-test-automation"],
  },
};

/**
 * Framework mappings with related topics and typical languages
 */
export const FRAMEWORK_MAPPINGS: Record<string, FrameworkConfig> = {
  // Python frameworks
  fastapi: {
    topics: ["fastapi", "api", "async", "pydantic"],
    keywords: ["api", "async", "rest", "openapi"],
    languages: ["Python"],
  },
  django: {
    topics: ["django", "web", "orm"],
    keywords: ["django", "web", "admin"],
    languages: ["Python"],
  },
  flask: {
    topics: ["flask", "web", "microframework"],
    keywords: ["flask", "web", "wsgi"],
    languages: ["Python"],
  },
  pytorch: {
    topics: ["pytorch", "deep-learning", "machine-learning"],
    keywords: ["tensor", "neural", "model"],
    languages: ["Python"],
  },
  langchain: {
    topics: ["langchain", "llm", "ai", "agents"],
    keywords: ["chain", "prompt", "llm", "rag"],
    languages: ["Python"],
  },

  // JavaScript/TypeScript frameworks
  react: {
    topics: ["react", "reactjs", "frontend", "ui"],
    keywords: ["component", "hooks", "jsx"],
    languages: ["TypeScript", "JavaScript"],
  },
  vue: {
    topics: ["vue", "vuejs", "frontend"],
    keywords: ["component", "composition", "reactive"],
    languages: ["TypeScript", "JavaScript"],
  },
  nextjs: {
    topics: ["nextjs", "react", "ssr", "fullstack"],
    keywords: ["pages", "app-router", "server-components"],
    languages: ["TypeScript", "JavaScript"],
  },
  nestjs: {
    topics: ["nestjs", "nodejs", "backend", "api"],
    keywords: ["module", "controller", "service"],
    languages: ["TypeScript"],
  },
  express: {
    topics: ["express", "nodejs", "backend", "api"],
    keywords: ["middleware", "router", "rest"],
    languages: ["TypeScript", "JavaScript"],
  },

  // Rust frameworks
  actix: {
    topics: ["actix", "actix-web", "rust", "async"],
    keywords: ["actor", "web", "async"],
    languages: ["Rust"],
  },
  tokio: {
    topics: ["tokio", "async", "rust", "runtime"],
    keywords: ["async", "runtime", "io"],
    languages: ["Rust"],
  },

  // Go frameworks
  gin: {
    topics: ["gin", "go", "web", "api"],
    keywords: ["router", "middleware", "rest"],
    languages: ["Go"],
  },
  echo: {
    topics: ["echo", "go", "web", "api"],
    keywords: ["router", "middleware", "rest"],
    languages: ["Go"],
  },

  // Testing frameworks
  pytest: {
    topics: ["pytest", "testing", "python"],
    keywords: ["fixture", "test", "assert"],
    languages: ["Python"],
  },
  jest: {
    topics: ["jest", "testing", "javascript"],
    keywords: ["mock", "snapshot", "test"],
    languages: ["TypeScript", "JavaScript"],
  },
  playwright: {
    topics: ["playwright", "e2e", "testing", "browser"],
    keywords: ["browser", "automation", "e2e"],
    languages: ["TypeScript", "JavaScript", "Python"],
  },
};

/**
 * Get all valid domain names
 */
export function getValidDomains(): string[] {
  return Object.keys(DOMAIN_MAPPINGS);
}

/**
 * Get all valid framework names
 */
export function getValidFrameworks(): string[] {
  return Object.keys(FRAMEWORK_MAPPINGS);
}

/**
 * Get domain config by name
 */
export function getDomainConfig(domain: string): DomainConfig | undefined {
  return DOMAIN_MAPPINGS[domain.toLowerCase()];
}

/**
 * Get framework config by name
 */
export function getFrameworkConfig(framework: string): FrameworkConfig | undefined {
  return FRAMEWORK_MAPPINGS[framework.toLowerCase()];
}

/**
 * Detection strategies for automated feedback tools
 */
export interface AutomatedToolDetection {
  configFiles: string[];
  githubApp?: string | undefined;
  prCommentAuthors: string[];
  checkBadge?: RegExp | undefined;
}

export const AUTOMATED_FEEDBACK_DETECTION: Record<string, AutomatedToolDetection> = {
  sourcery: {
    configFiles: [".sourcery.yaml", ".sourcery.yml"],
    githubApp: "sourcery-ai",
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
    configFiles: [],
    githubApp: "coderabbitai",
    prCommentAuthors: ["coderabbitai[bot]"],
  },

  gitguardian: {
    configFiles: [".gitguardian.yml", ".gitguardian.yaml"],
    githubApp: "gitguardian",
    prCommentAuthors: ["gitguardian[bot]"],
  },

  dependabot: {
    configFiles: [".github/dependabot.yml", ".github/dependabot.yaml"],
    prCommentAuthors: ["dependabot[bot]"],
  },

  renovate: {
    configFiles: ["renovate.json", ".renovaterc", ".renovaterc.json", "renovate.json5"],
    githubApp: "renovate",
    prCommentAuthors: ["renovate[bot]"],
  },

  "pre-commit-ci": {
    configFiles: [".pre-commit-config.yaml"],
    prCommentAuthors: ["pre-commit-ci[bot]"],
  },
};

/**
 * Get all known bot comment authors for automated tool detection
 */
export function getAllBotAuthors(): string[] {
  const authors = new Set<string>();
  for (const tool of Object.values(AUTOMATED_FEEDBACK_DETECTION)) {
    for (const author of tool.prCommentAuthors) {
      authors.add(author);
    }
  }
  return Array.from(authors);
}
