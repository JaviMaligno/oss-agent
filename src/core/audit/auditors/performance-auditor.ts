import { BaseAuditor, AuditContext } from "./base.js";
import { AuditCategory } from "../../../types/audit.js";
import { buildMasterAuditPrompt } from "../audit-prompts.js";

export class PerformanceAuditor extends BaseAuditor {
  readonly category: AuditCategory = "performance";
  readonly displayName = "Performance Auditor";

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
      "**/*.sql",
      "**/queries/**",
      "**/api/**",
      "**/components/**",
      "**/pages/**",
    ];
  }

  buildPrompt(repoPath: string, context: AuditContext): string {
    return (
      buildMasterAuditPrompt(context.owner, context.repo, this.category) +
      `

## Performance-Specific Analysis

Identify performance issues and optimization opportunities:

### 1. Database & Queries
- N+1 query problems (common with ORMs)
- Missing database indexes (inferred from query patterns)
- SELECT * instead of specific columns
- Unbounded queries without LIMIT
- Missing pagination for large datasets
- Inefficient JOINs or subqueries

### 2. Algorithm Complexity
- O(n²) or worse algorithms on potentially large data
- Nested loops over collections
- Repeated expensive computations
- Missing memoization/caching opportunities
- Inefficient sorting/searching

### 3. Memory & Resources
- Memory leaks (event listeners not removed, closures holding references)
- Large object accumulation
- Missing cleanup in components/classes
- Unbounded caches
- Large file loading into memory

### 4. I/O & Network
- Synchronous I/O in async contexts
- Missing request batching/deduplication
- Unnecessary API calls
- Missing compression
- No connection pooling
- Sequential operations that could be parallel

### 5. Frontend Performance (if applicable)
- Large bundle sizes
- Missing code splitting
- Unoptimized images
- Missing lazy loading
- Excessive re-renders
- Missing virtualization for long lists
- Blocking scripts in head

### 6. Concurrency Issues
- Race conditions
- Unnecessary locks
- Missing parallelization opportunities
- Thread safety issues

Severity guidelines:
- **critical**: Exponential algorithms on user data, obvious memory leaks in hot paths
- **high**: N+1 queries, O(n²) on large datasets, significant memory issues
- **medium**: Suboptimal queries, missing caching, inefficient patterns
- **low**: Minor optimizations, preemptive improvements

Repository path: ${repoPath}`
    );
  }
}
