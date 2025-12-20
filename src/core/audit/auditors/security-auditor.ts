import { BaseAuditor, AuditContext } from "./base.js";
import { AuditCategory } from "../../../types/audit.js";
import { buildMasterAuditPrompt } from "../audit-prompts.js";

export class SecurityAuditor extends BaseAuditor {
  readonly category: AuditCategory = "security";
  readonly displayName = "Security Auditor";

  getFilePatterns(): string[] {
    return [
      "**/*.ts",
      "**/*.js",
      "**/*.tsx",
      "**/*.jsx",
      "**/*.py",
      "**/*.go",
      "**/*.java",
      "**/*.rb",
      "**/package.json",
      "**/requirements.txt",
      "**/Cargo.toml",
      "**/.env*",
      "**/config/**",
      "**/auth/**",
      "**/api/**",
    ];
  }

  buildPrompt(repoPath: string, context: AuditContext): string {
    return (
      buildMasterAuditPrompt(context.owner, context.repo, this.category) +
      `

## Security-Specific Analysis

Focus on these high-priority security concerns:

### 1. Authentication & Authorization
- Missing or weak authentication checks
- Authorization bypass vulnerabilities
- Session management issues
- JWT/token security problems

### 2. Input Validation & Injection
- SQL injection vulnerabilities
- Command injection risks
- XSS (Cross-Site Scripting) vulnerabilities
- Path traversal attacks
- Template injection

### 3. Secrets & Credentials
- Hardcoded API keys, passwords, tokens
- Secrets in source code or config files
- Credentials in logs or error messages
- Missing .gitignore entries for sensitive files

### 4. Data Protection
- Sensitive data exposure
- Insecure data storage
- Missing encryption for sensitive data
- PII handling issues

### 5. Dependencies
- Known vulnerable dependencies
- Outdated security-critical packages
- Missing lockfiles

### 6. Cryptography
- Weak cryptographic algorithms (MD5, SHA1 for passwords)
- Insecure random number generation
- Hardcoded encryption keys

When reporting security findings:
- Include CWE ID if applicable (e.g., CWE-89 for SQL injection)
- Mark critical/high severity findings with requiresPrivateDisclosure: true
- DO NOT include actual exploit code or payloads
- Focus on vulnerability type, location, and remediation

Repository path: ${repoPath}`
    );
  }
}
