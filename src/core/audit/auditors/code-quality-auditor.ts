import { BaseAuditor, AuditContext } from "./base.js";
import { AuditCategory } from "../../../types/audit.js";
import { buildMasterAuditPrompt } from "../audit-prompts.js";

export class CodeQualityAuditor extends BaseAuditor {
  readonly category: AuditCategory = "code-quality";
  readonly displayName = "Code Quality Auditor";

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
      "**/*.rs",
      "**/*.cpp",
      "**/*.c",
      "**/*.cs",
    ];
  }

  buildPrompt(repoPath: string, context: AuditContext): string {
    return (
      buildMasterAuditPrompt(context.owner, context.repo, this.category) +
      `

## Code Quality-Specific Analysis

Evaluate code quality across these dimensions:

### 1. Code Smells
- Duplicated code (DRY violations)
- Long methods/functions (>50 lines)
- Large classes/modules
- Deep nesting (>3 levels)
- Magic numbers and strings
- God objects/modules

### 2. Naming & Readability
- Unclear or misleading names
- Inconsistent naming conventions
- Abbreviations that hurt readability
- Generic names (data, info, temp, etc.)

### 3. Error Handling
- Swallowed exceptions (empty catch blocks)
- Missing error handling for I/O operations
- Inconsistent error handling patterns
- Error messages lacking context
- Missing try-catch where needed

### 4. Code Organization
- Missing module boundaries
- Circular dependencies
- Improper layer separation
- Mixed concerns in single files
- Inconsistent file/folder structure

### 5. Dead Code & Technical Debt
- Unused functions, variables, imports
- Commented-out code
- TODO/FIXME/HACK comments (especially old ones)
- Deprecated code still in use
- Obsolete dependencies

### 6. Type Safety (for typed languages)
- Excessive use of 'any' type
- Missing type annotations
- Unsafe type assertions
- Nullable reference issues

Severity guidelines:
- **high**: Major architectural issues, critical error handling gaps, widespread code duplication
- **medium**: Significant code smells, inconsistent patterns, notable technical debt
- **low**: Minor style issues, small improvements, optional refactoring

Repository path: ${repoPath}`
    );
  }
}
