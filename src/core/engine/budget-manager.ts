/**
 * Budget Manager - Tracks and enforces budget limits
 *
 * Provides daily and monthly budget tracking with hard stops
 * when thresholds are exceeded.
 */

import { StateManager } from "../state/state-manager.js";
import { BudgetConfig } from "../../types/config.js";
import { logger } from "../../infra/logger.js";

/**
 * Result of a budget check
 */
export interface BudgetCheckResult {
  /** Whether work is allowed within budget */
  allowed: boolean;
  /** Reason if not allowed */
  reason?: string;
  /** Current daily spend */
  dailySpent: number;
  /** Daily limit */
  dailyLimit: number;
  /** Current monthly spend */
  monthlySpent: number;
  /** Monthly limit */
  monthlyLimit: number;
  /** Remaining daily budget */
  dailyRemaining: number;
  /** Remaining monthly budget */
  monthlyRemaining: number;
}

/**
 * Budget status summary
 */
export interface BudgetStatus {
  /** Today's total cost */
  todaysCost: number;
  /** This month's total cost */
  monthsCost: number;
  /** Daily limit from config */
  dailyLimit: number;
  /** Monthly limit from config */
  monthlyLimit: number;
  /** Percentage of daily budget used */
  dailyPercentUsed: number;
  /** Percentage of monthly budget used */
  monthlyPercentUsed: number;
  /** Whether daily limit is exceeded */
  dailyExceeded: boolean;
  /** Whether monthly limit is exceeded */
  monthlyExceeded: boolean;
}

/**
 * BudgetManager - Enforces budget limits
 */
export class BudgetManager {
  constructor(
    private stateManager: StateManager,
    private budgetConfig: BudgetConfig
  ) {}

  /**
   * Check if work can proceed within budget limits
   */
  canProceed(estimatedCost: number = 0): BudgetCheckResult {
    const dailySpent = this.stateManager.getTodaysCost();
    const monthlySpent = this.stateManager.getMonthsCost();

    const dailyLimit = this.budgetConfig.dailyLimitUsd;
    const monthlyLimit = this.budgetConfig.monthlyLimitUsd;

    const dailyRemaining = Math.max(0, dailyLimit - dailySpent);
    const monthlyRemaining = Math.max(0, monthlyLimit - monthlySpent);

    // Check if already over limits
    if (dailySpent >= dailyLimit) {
      logger.warn(`Daily budget exceeded: $${dailySpent.toFixed(2)} >= $${dailyLimit}`);
      return {
        allowed: false,
        reason: `Daily budget limit exceeded ($${dailySpent.toFixed(2)} / $${dailyLimit})`,
        dailySpent,
        dailyLimit,
        monthlySpent,
        monthlyLimit,
        dailyRemaining,
        monthlyRemaining,
      };
    }

    if (monthlySpent >= monthlyLimit) {
      logger.warn(`Monthly budget exceeded: $${monthlySpent.toFixed(2)} >= $${monthlyLimit}`);
      return {
        allowed: false,
        reason: `Monthly budget limit exceeded ($${monthlySpent.toFixed(2)} / $${monthlyLimit})`,
        dailySpent,
        dailyLimit,
        monthlySpent,
        monthlyLimit,
        dailyRemaining,
        monthlyRemaining,
      };
    }

    // Check if estimated cost would exceed limits
    if (estimatedCost > 0) {
      if (dailySpent + estimatedCost > dailyLimit) {
        logger.warn(
          `Estimated cost $${estimatedCost.toFixed(2)} would exceed daily limit ` +
            `($${dailySpent.toFixed(2)} + $${estimatedCost.toFixed(2)} > $${dailyLimit})`
        );
        return {
          allowed: false,
          reason: `Estimated cost would exceed daily limit`,
          dailySpent,
          dailyLimit,
          monthlySpent,
          monthlyLimit,
          dailyRemaining,
          monthlyRemaining,
        };
      }

      if (monthlySpent + estimatedCost > monthlyLimit) {
        logger.warn(
          `Estimated cost $${estimatedCost.toFixed(2)} would exceed monthly limit ` +
            `($${monthlySpent.toFixed(2)} + $${estimatedCost.toFixed(2)} > $${monthlyLimit})`
        );
        return {
          allowed: false,
          reason: `Estimated cost would exceed monthly limit`,
          dailySpent,
          dailyLimit,
          monthlySpent,
          monthlyLimit,
          dailyRemaining,
          monthlyRemaining,
        };
      }
    }

    return {
      allowed: true,
      dailySpent,
      dailyLimit,
      monthlySpent,
      monthlyLimit,
      dailyRemaining,
      monthlyRemaining,
    };
  }

  /**
   * Get current budget status
   */
  getStatus(): BudgetStatus {
    const todaysCost = this.stateManager.getTodaysCost();
    const monthsCost = this.stateManager.getMonthsCost();
    const dailyLimit = this.budgetConfig.dailyLimitUsd;
    const monthlyLimit = this.budgetConfig.monthlyLimitUsd;

    return {
      todaysCost,
      monthsCost,
      dailyLimit,
      monthlyLimit,
      dailyPercentUsed: (todaysCost / dailyLimit) * 100,
      monthlyPercentUsed: (monthsCost / monthlyLimit) * 100,
      dailyExceeded: todaysCost >= dailyLimit,
      monthlyExceeded: monthsCost >= monthlyLimit,
    };
  }

  /**
   * Get the effective per-issue budget considering remaining limits
   */
  getEffectivePerIssueBudget(): number {
    const check = this.canProceed();
    const perIssueLimit = this.budgetConfig.perIssueLimitUsd;

    // Return the minimum of per-issue limit and remaining budget
    return Math.min(perIssueLimit, check.dailyRemaining, check.monthlyRemaining);
  }

  /**
   * Check if a specific cost would be within budget
   */
  isWithinBudget(cost: number): boolean {
    return this.canProceed(cost).allowed;
  }
}
