import { BaseAuditor, AuditContext } from "./base.js";
import { AuditCategory } from "../../../types/audit.js";
import { buildMasterAuditPrompt } from "../audit-prompts.js";

export class TestCoverageAuditor extends BaseAuditor {
  readonly category: AuditCategory = "test-coverage";
  readonly displayName = "Test Coverage Auditor";

  getFilePatterns(): string[] {
    return [
      // Test files
      "**/*.test.ts",
      "**/*.test.js",
      "**/*.spec.ts",
      "**/*.spec.js",
      "**/test/**",
      "**/tests/**",
      "**/__tests__/**",
      "**/test_*.py",
      "**/*_test.py",
      "**/test*.py",
      "**/*_test.go",
      "**/*Test.java",
      // Config files
      "jest.config.*",
      "vitest.config.*",
      "pytest.ini",
      "setup.cfg",
      ".nycrc*",
      "coverage/**",
      ".coveragerc",
      // Source files to check coverage
      "src/**/*.ts",
      "src/**/*.js",
      "lib/**/*.ts",
      "lib/**/*.js",
    ];
  }

  buildPrompt(repoPath: string, context: AuditContext): string {
    return (
      buildMasterAuditPrompt(context.owner, context.repo, this.category) +
      `

## Test Coverage-Specific Analysis

Evaluate the testing strategy and identify coverage gaps:

### 1. Test Infrastructure
- Is a testing framework configured? (Jest, Vitest, pytest, etc.)
- Are tests organized properly?
- Is CI running tests?
- Is coverage reporting set up?

### 2. Critical Path Coverage
Look for untested code in critical areas:
- Authentication and authorization logic
- Payment/billing code
- Data validation and sanitization
- API endpoints (especially POST/PUT/DELETE)
- Security controls
- Error handling paths
- Core business logic

### 3. Test Quality Issues
- Tests that don't assert anything meaningful
- Overly brittle tests (break with minor changes)
- Tests with unclear intent or poor descriptions
- Tests that test implementation instead of behavior
- Flaky tests (if identifiable from patterns)
- Over-mocking (testing mocks instead of real logic)

### 4. Missing Test Types
- Unit tests for utilities and helpers
- Integration tests for API endpoints
- Edge case tests (null, empty, boundary values)
- Error condition tests
- Async/await error handling tests

### 5. Test Patterns
- Are there test utilities/fixtures for common setups?
- Is test data management consistent?
- Are mocks/stubs used appropriately?
- Is there test isolation (no shared state)?

### 6. Coverage Gaps by Module
Identify specific modules/files that appear to lack tests:
- Compare src/ structure to test/ structure
- Look for complex files without corresponding tests
- Identify public APIs without test coverage

Severity guidelines:
- **critical**: Authentication/security code untested, payment logic without tests
- **high**: Core API endpoints untested, important business logic missing tests
- **medium**: Utility functions untested, missing edge case tests
- **low**: Could benefit from more tests, test improvements

Repository path: ${repoPath}`
    );
  }
}
