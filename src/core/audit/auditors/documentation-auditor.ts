import { BaseAuditor, AuditContext } from "./base.js";
import { AuditCategory } from "../../../types/audit.js";
import { buildMasterAuditPrompt } from "../audit-prompts.js";

export class DocumentationAuditor extends BaseAuditor {
  readonly category: AuditCategory = "documentation";
  readonly displayName = "Documentation Auditor";

  getFilePatterns(): string[] {
    return [
      "README.md",
      "README*",
      "readme*",
      "CONTRIBUTING.md",
      "CONTRIBUTING*",
      "CODE_OF_CONDUCT.md",
      "LICENSE*",
      "CHANGELOG*",
      "docs/**",
      "documentation/**",
      "**/package.json",
      "**/setup.py",
      "**/pyproject.toml",
      "**/*.md",
    ];
  }

  buildPrompt(repoPath: string, context: AuditContext): string {
    return (
      buildMasterAuditPrompt(context.owner, context.repo, this.category) +
      `

## Documentation-Specific Analysis

Evaluate the repository's documentation quality:

### 1. README Quality
- Project description and purpose
- Installation instructions (complete and accurate?)
- Usage examples (working code samples?)
- Prerequisites and requirements
- Quick start guide
- Badges (CI status, coverage, version)

### 2. API Documentation
- Public functions/methods documented
- Parameter descriptions
- Return value documentation
- Error conditions documented
- Code examples

### 3. Contributing Guide
- CONTRIBUTING.md present?
- Development setup instructions
- Code style guidelines
- Pull request process
- Issue reporting guidelines

### 4. Other Documentation
- LICENSE file present and appropriate?
- CHANGELOG maintained?
- CODE_OF_CONDUCT.md?
- Architecture/design documentation?
- Deployment documentation?

### 5. Code Comments
- Complex logic explained?
- Non-obvious code commented?
- TODO/FIXME comments tracked?
- Outdated comments?

Severity guidelines for documentation:
- **high**: Missing README, no installation instructions, public API undocumented
- **medium**: Incomplete setup guide, missing CONTRIBUTING.md, outdated examples
- **low**: Minor gaps, could use more examples, formatting issues

Repository path: ${repoPath}`
    );
  }
}
