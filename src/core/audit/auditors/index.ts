import { BaseAuditor } from "./base.js";
import { SecurityAuditor } from "./security-auditor.js";
import { DocumentationAuditor } from "./documentation-auditor.js";
import { CodeQualityAuditor } from "./code-quality-auditor.js";
import { PerformanceAuditor } from "./performance-auditor.js";
import { TestCoverageAuditor } from "./test-coverage-auditor.js";
import { AuditCategory } from "../../../types/audit.js";

// Export all auditor classes
export { BaseAuditor } from "./base.js";
export type { AuditContext } from "./base.js";
export { SecurityAuditor } from "./security-auditor.js";
export { DocumentationAuditor } from "./documentation-auditor.js";
export { CodeQualityAuditor } from "./code-quality-auditor.js";
export { PerformanceAuditor } from "./performance-auditor.js";
export { TestCoverageAuditor } from "./test-coverage-auditor.js";

/**
 * Registry of all available auditors by category
 */
export const AUDITOR_REGISTRY: Record<AuditCategory, new () => BaseAuditor> = {
  security: SecurityAuditor,
  documentation: DocumentationAuditor,
  "code-quality": CodeQualityAuditor,
  performance: PerformanceAuditor,
  "test-coverage": TestCoverageAuditor,
};

/**
 * Create an auditor instance for a given category
 */
export function createAuditor(category: AuditCategory): BaseAuditor {
  const AuditorClass = AUDITOR_REGISTRY[category];
  if (!AuditorClass) {
    throw new Error(`Unknown audit category: ${category}`);
  }
  return new AuditorClass();
}

/**
 * Create auditor instances for multiple categories
 */
export function createAuditors(categories: AuditCategory[]): BaseAuditor[] {
  return categories.map((category) => createAuditor(category));
}

/**
 * Get all available audit categories
 */
export function getAvailableCategories(): AuditCategory[] {
  return Object.keys(AUDITOR_REGISTRY) as AuditCategory[];
}

/**
 * Check if a category is valid
 */
export function isValidCategory(category: string): category is AuditCategory {
  return category in AUDITOR_REGISTRY;
}
