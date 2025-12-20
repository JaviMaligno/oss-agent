# Wave 2B: Finding Processor & Security Disclosure Manager

This document explains how to use the `FindingProcessor` and `SecurityDisclosureManager` classes introduced in Wave 2B of Phase 7.1.

## Overview

Wave 2B provides two key components:

1. **FindingProcessor** - Converts audit findings into GitHub issues
2. **SecurityDisclosureManager** - Handles responsible disclosure of security findings

## FindingProcessor

The `FindingProcessor` class is responsible for converting audit findings into GitHub issues based on configuration rules.

### Features

- Filters findings based on severity and configuration mode
- Creates GitHub issues with properly formatted titles and bodies
- Skips security findings (handled by SecurityDisclosureManager)
- Updates finding status in the database
- Supports multiple issue creation modes: `auto`, `approve`, `never`

### Usage Example

```typescript
import { FindingProcessor } from "./core/audit/finding-processor.js";
import { StateManager } from "./core/state/state-manager.js";
import { AuditConfig } from "./types/audit.js";

// Initialize
const stateManager = new StateManager("/path/to/data");
const config: AuditConfig = {
  categories: ["documentation", "code-quality"],
  minSeverity: "medium",
  minConfidence: "medium",
  issueCreation: {
    mode: "auto", // or "approve" or "never"
    autoCreateSeverities: ["critical", "high", "medium"],
    issueLabels: ["audit-finding", "automated"],
  },
  security: {
    disclosureMode: "advisory",
    advisorySeverities: ["critical", "high"],
  },
  autoResolve: {
    enabled: false,
    maxPerRun: 3,
    maxBudgetPerFinding: 5,
  },
  maxBudgetPerAudit: 10,
};

const processor = new FindingProcessor(stateManager, config);

// Process findings
const findings = stateManager.getAuditFindings(auditRunId);
const results = await processor.processFindings(findings);

// Check results
for (const result of results) {
  if (result.issueCreated) {
    console.log(`Created issue: ${result.issueUrl}`);
  } else if (result.error) {
    console.log(`Failed: ${result.error}`);
  }
}
```

### Issue Creation Modes

1. **`auto` mode**: Automatically creates issues for findings with specified severities
   - Configure `autoCreateSeverities` to control which severity levels trigger auto-creation
   - Example: `["critical", "high", "medium"]`

2. **`approve` mode**: Only creates issues for findings marked as "approved"
   - Requires manual approval via `stateManager.updateAuditFinding(id, { status: "approved" })`
   - Useful for human-in-the-loop workflows

3. **`never` mode**: Never creates issues automatically
   - Useful for dry-run audits or when issues should be created manually

### Issue Format

Issues are created with the following format:

**Title**: `[category] Finding Title`

**Body**:
```markdown
## Description
[Finding description]

## Location
`file/path.ts:123`

## Evidence
```code
// Code snippet
```

## Impact
**Severity:** high
**Confidence:** medium

## Recommendation
[Recommendation text]

## Additional Context
**key:** value

---
_This issue was automatically discovered by oss-agent_
```

**Labels**: `[audit-finding, category, severity-severity]`

## SecurityDisclosureManager

The `SecurityDisclosureManager` class handles responsible disclosure of security vulnerabilities.

### Features

- Multiple disclosure modes: `advisory`, `private-issue`, `public-issue`
- Creates GitHub Security Advisories for critical/high severity findings
- Maps severity levels to GitHub advisory format
- Sanitizes descriptions (no exploit code or attack vectors)
- Extracts CWE IDs from finding metadata

### Usage Example

```typescript
import { SecurityDisclosureManager } from "./core/audit/security-disclosure.js";
import { AuditConfig } from "./types/audit.js";

// Initialize
const config: AuditConfig = {
  categories: ["security"],
  minSeverity: "low",
  minConfidence: "medium",
  issueCreation: {
    mode: "never", // Security findings handled separately
    issueLabels: [],
  },
  security: {
    disclosureMode: "advisory", // or "private-issue" or "public-issue"
    advisorySeverities: ["critical", "high"], // Always use advisory for these
  },
  autoResolve: {
    enabled: false,
    maxPerRun: 3,
    maxBudgetPerFinding: 5,
  },
  maxBudgetPerAudit: 10,
};

const disclosureManager = new SecurityDisclosureManager(config);

// Disclose a security finding
const result = await disclosureManager.disclose("owner/repo", securityFinding);

if (result.success) {
  console.log(`Disclosed via ${result.mode}: ${result.url}`);
} else {
  console.log(`Disclosure failed: ${result.error}`);
}
```

### Disclosure Modes

1. **`advisory` mode**: Creates a GitHub Security Advisory (draft)
   - Used for critical and high severity findings
   - Keeps vulnerability private until maintainers publish
   - Requires repository permissions to create advisories
   - Maps severity to GitHub advisory severity: `critical`, `high`, `moderate`, `low`

2. **`private-issue` mode**: Creates a regular issue with security labels
   - Note: GitHub doesn't support truly "private" issues in public repos
   - Marked with `[SECURITY]` prefix and security labels
   - Useful for lower-severity findings

3. **`public-issue` mode**: Creates a public issue for low-severity findings
   - Used when the vulnerability doesn't require private disclosure
   - Still uses security labels for categorization

### Severity Mapping

The manager automatically maps audit severity levels to GitHub advisory severity:

| Audit Severity | GitHub Advisory Severity |
|---------------|-------------------------|
| critical      | critical                |
| high          | high                    |
| medium        | moderate                |
| low           | low                     |
| info          | low                     |

### Security Best Practices

1. **No exploit details**: Advisory descriptions never include:
   - Proof-of-concept exploit code
   - Detailed attack vectors
   - Sensitive metadata (filtered out)

2. **Responsible disclosure**:
   - Use `advisory` mode for critical/high severity
   - Give maintainers time to fix before public disclosure
   - Follow industry-standard disclosure timelines

3. **CWE Integration**:
   - Include CWE IDs in finding metadata for automatic inclusion
   - Supported keys: `cwe`, `cweId`, `CWE`
   - Example: `{ metadata: { cwe: "CWE-79" } }` → extracts `79`

## Integration with AuditService

To integrate these components into the audit workflow:

```typescript
// In AuditService.auditRepository()
// After saving findings to state...

// 1. Process security findings separately
const securityFindings = filteredFindings.filter(f => f.category === "security");
const securityDisclosure = new SecurityDisclosureManager(auditConfig);

for (const finding of securityFindings) {
  const result = await securityDisclosure.disclose(projectId, finding);
  if (result.success) {
    stateManager.updateAuditFinding(finding.id, {
      status: "issue_created",
      issueUrl: result.url,
    });
  }
}

// 2. Process non-security findings
const nonSecurityFindings = filteredFindings.filter(f => f.category !== "security");
const findingProcessor = new FindingProcessor(stateManager, auditConfig);
await findingProcessor.processFindings(nonSecurityFindings);
```

## Error Handling

Both classes handle errors gracefully:

```typescript
// FindingProcessor returns error in result
const results = await processor.processFindings(findings);
for (const result of results) {
  if (result.error) {
    logger.error(`Failed to process finding ${result.finding.id}: ${result.error}`);
  }
}

// SecurityDisclosureManager returns error in result
const result = await disclosureManager.disclose(projectId, finding);
if (!result.success) {
  logger.error(`Failed to disclose finding ${result.finding.id}: ${result.error}`);
}
```

## Testing

To test these components manually:

```bash
# 1. Create test findings in database
# 2. Configure audit settings
# 3. Run processing

# Example:
pnpm run dev audit process-findings --audit-run-id run-123
```

## Future Enhancements

Planned improvements for Wave 3:

- Batch issue creation for better rate limit handling
- Issue templates support
- Webhook notifications for created issues
- Integration with issue assignment workflows
- Support for project-specific disclosure policies
