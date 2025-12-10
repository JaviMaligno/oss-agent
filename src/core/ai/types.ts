/**
 * Types for AI Provider abstraction
 */

export interface QueryOptions {
  /** Working directory for file operations */
  cwd: string;
  /** Model to use (if supported by provider) */
  model?: string;
  /** Maximum turns/iterations */
  maxTurns?: number;
  /** Maximum budget in USD (SDK mode only) */
  maxBudgetUsd?: number;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Additional context to prepend to the prompt */
  systemContext?: string;
}

export interface QueryResult {
  /** Whether the query completed successfully */
  success: boolean;
  /** The final output/response from the AI */
  output: string;
  /** Session ID for potential resume (if supported) */
  sessionId?: string;
  /** Total cost in USD (if trackable) */
  costUsd?: number;
  /** Number of turns/iterations used */
  turns: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Error message if success is false */
  error?: string;
  /** Raw output from the provider (for debugging) */
  rawOutput?: string;
}

export interface ProviderCapabilities {
  /** Can track costs */
  costTracking: boolean;
  /** Can resume sessions */
  sessionResume: boolean;
  /** Supports streaming output */
  streaming: boolean;
  /** Supports budget limits */
  budgetLimits: boolean;
}

export interface AIProvider {
  /** Provider name for logging */
  readonly name: string;

  /** Provider capabilities */
  readonly capabilities: ProviderCapabilities;

  /**
   * Execute a query/prompt
   */
  query(prompt: string, options: QueryOptions): Promise<QueryResult>;

  /**
   * Check if the provider is available/configured
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get current usage statistics
   */
  getUsage(): ProviderUsage;
}

export interface ProviderUsage {
  /** Total queries made */
  totalQueries: number;
  /** Total cost in USD (if trackable) */
  totalCostUsd: number;
  /** Total turns across all queries */
  totalTurns: number;
  /** Queries made today */
  queriesToday: number;
  /** Cost today in USD */
  costTodayUsd: number;
}
