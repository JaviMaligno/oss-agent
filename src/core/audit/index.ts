// Audit service
export { AuditService, type AuditOptions } from "./audit-service.js";

// Base auditor
export { BaseAuditor, type AuditContext } from "./auditors/base.js";

// Audit prompts
export {
  buildMasterAuditPrompt,
  getCategoryDescription,
  getCategoryGuidance,
  getCategoryFilePatterns,
  FINDING_OUTPUT_SCHEMA,
  CONFIDENCE_GUIDELINES,
  SEVERITY_GUIDELINES,
} from "./audit-prompts.js";

// Audit finding processing
export { FindingProcessor, type ProcessedFinding } from "./finding-processor.js";

// Security disclosure
export {
  SecurityDisclosureManager,
  type DisclosureMode,
  type DisclosureResult,
} from "./security-disclosure.js";
