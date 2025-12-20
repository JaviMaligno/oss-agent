import { AuditCategory } from "../../types/audit.js";

/**
 * Build a tool-based audit prompt for AI analysis
 *
 * Instead of asking the AI to output JSON, we instruct it to use
 * the report_audit_finding tool for each issue it discovers.
 */
export function buildToolBasedAuditPrompt(
  owner: string,
  repo: string,
  category: AuditCategory,
  additionalContext?: string
): string {
  const categoryDescription = getCategoryDescription(category);
  const categoryGuidance = getCategoryGuidance(category);

  return `You are performing a ${category} audit for the GitHub repository ${owner}/${repo}.

## Audit Category: ${category}

${categoryDescription}

## Your Task

Analyze the codebase for issues in the **${category}** category. Focus on finding real, actionable issues that can be fixed.

${categoryGuidance}

## Instructions

1. **Explore the codebase** - Use Read and Glob tools to examine relevant files and understand the code structure
2. **Identify issues** - Look for problems that match the category criteria
3. **Report each finding** - For EACH issue you find, call the \`report_audit_finding\` tool with all relevant details
4. **Complete the audit** - When done analyzing, call the \`complete_audit\` tool with a summary

## CRITICAL: How to Report Findings

You MUST use the \`report_audit_finding\` tool for EACH issue you discover. Do NOT just describe issues in text - you MUST call the tool.

Example: If you find a hardcoded password, call the tool like this:
- tool: report_audit_finding
- title: "Hardcoded password in config"
- severity: "high"
- confidence: "high"
- description: "The config.py file contains a hardcoded database password..."
- filePath: "src/config.py"
- lineNumber: 42
- recommendation: "Move the password to an environment variable"

## Confidence Guidelines

${CONFIDENCE_GUIDELINES}

## Severity Guidelines

${SEVERITY_GUIDELINES}

## Important Notes

- **Call report_audit_finding for EACH issue** - This is how findings are recorded
- Only report findings where you have at least medium confidence
- Be specific: include file paths, line numbers, and code snippets when possible
- Focus on quality over quantity - one well-documented finding is better than many vague ones
- If you find no significant issues, still call \`complete_audit\` with noIssuesFound: true
- Make recommendations actionable and specific

${additionalContext ? `\n## Additional Context\n\n${additionalContext}` : ""}

Begin your analysis now. Explore the repository, identify ${category} issues, and report each one using the report_audit_finding tool.`;
}

/**
 * @deprecated Use buildToolBasedAuditPrompt instead - JSON output is unreliable
 */
export function buildMasterAuditPrompt(
  owner: string,
  repo: string,
  category: AuditCategory,
  additionalContext?: string
): string {
  // Redirect to tool-based prompt
  return buildToolBasedAuditPrompt(owner, repo, category, additionalContext);
}

/**
 * JSON schema for audit finding output
 */
export const FINDING_OUTPUT_SCHEMA = `{
  "findings": [
    {
      "category": "security",
      "severity": "high",
      "confidence": 0.85,
      "title": "Brief title (50 chars max)",
      "description": "Detailed explanation of the issue",
      "filePath": "src/file.ts",
      "lineNumber": 42,
      "codeSnippet": "relevant code",
      "recommendation": "How to fix this issue",
      "tags": ["tag1", "tag2"]
    }
  ]
}`;

/**
 * Confidence scoring guidelines for AI
 */
export const CONFIDENCE_GUIDELINES = `## Confidence Scoring (0.0-1.0)
- **0.9-1.0**: Verified through code examination, clearly present in the code
- **0.7-0.9**: Strong evidence based on patterns, not execution-tested
- **0.5-0.7**: Pattern suggests issue, needs validation or testing
- **<0.5**: Don't report (too uncertain)

When assigning confidence:
- Higher confidence for issues you can see directly in the code
- Lower confidence for issues that depend on runtime behavior
- Consider whether the issue could be a false positive`;

/**
 * Severity level guidelines for AI
 */
export const SEVERITY_GUIDELINES = `## Severity Levels

- **critical**:
  - Security vulnerabilities that could be exploited
  - Data loss or corruption issues
  - System crashes or complete service failures

- **high**:
  - Significant bugs affecting core functionality
  - Performance issues causing major degradation
  - Security concerns that need addressing
  - Missing critical tests or documentation

- **medium**:
  - Moderate bugs with workarounds
  - Code quality issues affecting maintainability
  - Performance issues with localized impact
  - Incomplete documentation

- **low**:
  - Code smells and minor quality issues
  - Minor optimizations
  - Style inconsistencies

- **info**:
  - Informational findings
  - Suggestions for improvement
  - Best practice recommendations`;

/**
 * Get category-specific description
 */
export function getCategoryDescription(category: AuditCategory): string {
  switch (category) {
    case "security":
      return `**Security Audit**: Identify security vulnerabilities, unsafe code patterns, and potential attack vectors.`;

    case "performance":
      return `**Performance Audit**: Identify performance bottlenecks, inefficient algorithms, and resource usage issues.`;

    case "documentation":
      return `**Documentation Audit**: Identify missing or inadequate documentation, unclear README files, and lack of API documentation.`;

    case "code-quality":
      return `**Code Quality Audit**: Identify code smells, maintainability issues, and violations of best practices.`;

    case "test-coverage":
      return `**Test Coverage Audit**: Identify missing tests, inadequate test coverage, and untested edge cases.`;

    default:
      return `**${category} Audit**: Analyze code for issues in this category.`;
  }
}

/**
 * Get category-specific guidance for AI
 */
export function getCategoryGuidance(category: AuditCategory): string {
  switch (category) {
    case "security":
      return `### What to Look For

- **Authentication & Authorization**: Missing checks, weak credentials, insecure session management
- **Input Validation**: SQL injection, XSS, command injection vulnerabilities
- **Cryptography**: Weak algorithms, hardcoded secrets, insecure random number generation
- **Dependencies**: Known vulnerabilities in packages (check package.json, requirements.txt, etc.)
- **Secrets**: Exposed API keys, passwords, tokens in code or config files
- **Unsafe Functions**: Use of eval(), exec(), dangerous deserialization
- **File Operations**: Path traversal, arbitrary file read/write
- **API Security**: Missing rate limiting, CORS issues, insecure endpoints

### Files to Check
- Authentication/authorization code
- Input handling and validation
- Database queries
- Configuration files
- Environment variables
- Dependency manifests (package.json, requirements.txt, go.mod, etc.)`;

    case "performance":
      return `### What to Look For

- **Algorithmic Complexity**: O(n²) or worse algorithms where O(n) or O(log n) is possible
- **Database**: N+1 queries, missing indexes, inefficient queries
- **Memory**: Memory leaks, large object retention, unnecessary copying
- **I/O**: Synchronous I/O in critical paths, missing caching
- **Concurrency**: Lock contention, thread pool exhaustion, race conditions
- **Resource Management**: File handles not closed, connection pools not managed

### Files to Check
- Core business logic
- Database query code
- API endpoints
- Data processing functions
- Loop-heavy code`;

    case "documentation":
      return `### What to Look For

- **README**: Missing setup instructions, unclear usage examples
- **API Documentation**: Undocumented functions, missing parameter descriptions
- **Code Comments**: Complex logic without explanation, outdated comments
- **Contributing Guide**: Missing or incomplete CONTRIBUTING.md
- **Architecture**: No high-level architecture documentation
- **Examples**: Missing usage examples or tutorials

### Files to Check
- README.md
- CONTRIBUTING.md
- API documentation files
- Complex functions/classes
- Public interfaces`;

    case "code-quality":
      return `### What to Look For

- **Code Smells**: Long functions, duplicate code, god objects
- **Complexity**: High cyclomatic complexity, deep nesting
- **Naming**: Unclear variable/function names, inconsistent naming
- **Error Handling**: Missing error checks, swallowed exceptions, unclear error messages
- **Dependencies**: Unused imports, circular dependencies
- **Dead Code**: Unused functions, commented-out code
- **Magic Numbers**: Unexplained constants in code

### Files to Check
- Core business logic
- Complex functions
- Legacy code sections
- Frequently changed files`;

    case "test-coverage":
      return `### What to Look For

- **Missing Tests**: Core functionality without tests
- **Edge Cases**: Untested error paths, boundary conditions
- **Integration**: Missing integration tests for critical flows
- **Test Quality**: Tests that don't assert anything, flaky tests
- **Coverage Gaps**: Low coverage in critical paths
- **Test Organization**: Poor test structure, unclear test names

### Files to Check
- Test directories (test/, tests/, __tests__)
- Core business logic (check if corresponding tests exist)
- Configuration files (check if test setup is correct)`;

    default:
      return "";
  }
}

/**
 * Get file patterns to focus on for a category
 */
export function getCategoryFilePatterns(category: AuditCategory): string[] {
  switch (category) {
    case "security":
      return [
        "**/auth*.{ts,js,py,go,rs}",
        "**/security*.{ts,js,py,go,rs}",
        "**/config*.{ts,js,py,go,rs}",
        "**/.env*",
        "**/package.json",
        "**/requirements.txt",
        "**/go.mod",
        "**/Cargo.toml",
      ];

    case "performance":
      return [
        "**/api/**/*.{ts,js,py,go,rs}",
        "**/routes/**/*.{ts,js,py,go,rs}",
        "**/handlers/**/*.{ts,js,py,go,rs}",
        "**/services/**/*.{ts,js,py,go,rs}",
        "**/database/**/*.{ts,js,py,go,rs}",
        "**/queries/**/*.{ts,js,py,go,rs}",
      ];

    case "documentation":
      return ["**/README*.md", "**/CONTRIBUTING*.md", "**/docs/**/*.md", "**/*.md"];

    case "code-quality":
      return [
        "**/*.{ts,js,py,go,rs}",
        "!**/test/**",
        "!**/tests/**",
        "!**/__tests__/**",
        "!**/node_modules/**",
        "!**/vendor/**",
        "!**/dist/**",
        "!**/build/**",
      ];

    case "test-coverage":
      return [
        "**/test/**/*.{ts,js,py,go,rs}",
        "**/tests/**/*.{ts,js,py,go,rs}",
        "**/__tests__/**/*.{ts,js,py,go,rs}",
        "**/*_test.{go,rs}",
        "**/*_spec.{ts,js}",
        "**/*.test.{ts,js,py}",
      ];

    default:
      return ["**/*.{ts,js,py,go,rs}"];
  }
}
