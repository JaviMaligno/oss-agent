/**
 * PR Monitor - Watches PRs for new feedback and status changes
 */

import { EventEmitter } from "node:events";
import { logger } from "../../infra/logger.js";
import { PRService } from "./pr-service.js";
import { FeedbackParser } from "./feedback-parser.js";
import { FeedbackParseResult, PullRequest } from "../../types/pr.js";

export interface PRMonitorOptions {
  /** Poll interval in milliseconds */
  pollIntervalMs?: number;
  /** Stop monitoring after this many minutes of inactivity */
  inactivityTimeoutMins?: number;
}

export interface MonitoredPR {
  /** PR URL */
  url: string;
  /** Owner */
  owner: string;
  /** Repo */
  repo: string;
  /** PR number */
  prNumber: number;
  /** Last known head SHA */
  lastHeadSha: string;
  /** Last known comment count */
  lastCommentCount: number;
  /** Last known review count */
  lastReviewCount: number;
  /** Last feedback parse result */
  lastFeedback: FeedbackParseResult | null;
  /** Timestamp of last activity */
  lastActivityAt: Date;
  /** Whether currently polling */
  isPolling: boolean;
}

export type PRMonitorEvent =
  | "feedback" // New feedback received
  | "checks_changed" // CI status changed
  | "merged" // PR was merged
  | "closed" // PR was closed
  | "error"; // Error occurred

export interface PRMonitorEventData {
  pr: PullRequest;
  feedback?: FeedbackParseResult;
  previousFeedback?: FeedbackParseResult;
  error?: Error;
}

export class PRMonitor extends EventEmitter {
  private prService: PRService;
  private feedbackParser: FeedbackParser;
  private options: Required<PRMonitorOptions>;
  private monitoredPRs: Map<string, MonitoredPR> = new Map();
  private pollTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private running = false;

  constructor(
    prService: PRService,
    feedbackParser: FeedbackParser,
    options: PRMonitorOptions = {}
  ) {
    super();
    this.prService = prService;
    this.feedbackParser = feedbackParser;
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? 60_000, // 1 minute
      inactivityTimeoutMins: options.inactivityTimeoutMins ?? 60, // 1 hour
    };
  }

  /**
   * Whether the monitor is currently running
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Start monitoring a PR
   */
  async startMonitoring(prUrl: string): Promise<MonitoredPR> {
    const parsed = this.prService.parsePRUrl(prUrl);
    if (!parsed) {
      throw new Error(`Invalid PR URL: ${prUrl}`);
    }

    const { owner, repo, prNumber } = parsed;
    const key = `${owner}/${repo}#${prNumber}`;

    // Check if already monitoring
    if (this.monitoredPRs.has(key)) {
      logger.debug(`Already monitoring ${key}`);
      return this.monitoredPRs.get(key)!;
    }

    logger.info(`Starting to monitor PR: ${key}`);

    // Fetch initial state
    const { pr, reviews, comments, checks } = await this.prService.getPRFeedback(
      owner,
      repo,
      prNumber
    );

    const feedback = this.feedbackParser.parse(pr, reviews, comments, checks);

    const monitored: MonitoredPR = {
      url: prUrl,
      owner,
      repo,
      prNumber,
      lastHeadSha: pr.headSha,
      lastCommentCount: comments.length,
      lastReviewCount: reviews.length,
      lastFeedback: feedback,
      lastActivityAt: new Date(),
      isPolling: true,
    };

    this.monitoredPRs.set(key, monitored);
    this.running = true;

    // Start polling
    this.schedulePoll(key);

    return monitored;
  }

  /**
   * Stop monitoring a PR
   */
  stopMonitoring(prUrl: string): void {
    const parsed = this.prService.parsePRUrl(prUrl);
    if (!parsed) return;

    const { owner, repo, prNumber } = parsed;
    const key = `${owner}/${repo}#${prNumber}`;

    const timer = this.pollTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.pollTimers.delete(key);
    }

    const monitored = this.monitoredPRs.get(key);
    if (monitored) {
      monitored.isPolling = false;
      logger.info(`Stopped monitoring PR: ${key}`);
    }

    this.monitoredPRs.delete(key);

    if (this.monitoredPRs.size === 0) {
      this.running = false;
    }
  }

  /**
   * Stop monitoring all PRs
   */
  stopAll(): void {
    for (const timer of this.pollTimers.values()) {
      clearTimeout(timer);
    }
    this.pollTimers.clear();
    this.monitoredPRs.clear();
    this.running = false;
    logger.info("Stopped all PR monitoring");
  }

  /**
   * Get current monitoring state for a PR
   */
  getMonitoredPR(prUrl: string): MonitoredPR | null {
    const parsed = this.prService.parsePRUrl(prUrl);
    if (!parsed) return null;

    const { owner, repo, prNumber } = parsed;
    const key = `${owner}/${repo}#${prNumber}`;
    return this.monitoredPRs.get(key) ?? null;
  }

  /**
   * Get all monitored PRs
   */
  getAllMonitored(): MonitoredPR[] {
    return Array.from(this.monitoredPRs.values());
  }

  /**
   * Check PR once (without continuous monitoring)
   */
  async checkOnce(prUrl: string): Promise<FeedbackParseResult> {
    const parsed = this.prService.parsePRUrl(prUrl);
    if (!parsed) {
      throw new Error(`Invalid PR URL: ${prUrl}`);
    }

    const { owner, repo, prNumber } = parsed;
    const { pr, reviews, comments, checks } = await this.prService.getPRFeedback(
      owner,
      repo,
      prNumber
    );

    return this.feedbackParser.parse(pr, reviews, comments, checks);
  }

  /**
   * Schedule next poll for a PR
   */
  private schedulePoll(key: string): void {
    const timer = setTimeout(async () => {
      await this.pollPR(key);
    }, this.options.pollIntervalMs);

    this.pollTimers.set(key, timer);
  }

  /**
   * Poll a PR for updates
   */
  private async pollPR(key: string): Promise<void> {
    const monitored = this.monitoredPRs.get(key);
    if (!monitored?.isPolling) {
      return;
    }

    try {
      logger.debug(`Polling PR: ${key}`);

      const { pr, reviews, comments, checks } = await this.prService.getPRFeedback(
        monitored.owner,
        monitored.repo,
        monitored.prNumber
      );

      // Check for PR state changes
      if (pr.state === "merged") {
        this.emit("merged", { pr } as PRMonitorEventData);
        this.stopMonitoring(monitored.url);
        return;
      }

      if (pr.state === "closed") {
        this.emit("closed", { pr } as PRMonitorEventData);
        this.stopMonitoring(monitored.url);
        return;
      }

      const feedback = this.feedbackParser.parse(pr, reviews, comments, checks);
      const previousFeedback = monitored.lastFeedback;

      // Detect changes
      const hasNewComments = comments.length > monitored.lastCommentCount;
      const hasNewReviews = reviews.length > monitored.lastReviewCount;
      const hasNewFeedback = hasNewComments || hasNewReviews;

      // Check for CI status changes
      const previousChecksPass = previousFeedback?.pr.checksPass;
      const currentChecksPass = pr.checksPass;
      const checksChanged = previousChecksPass !== currentChecksPass;

      // Update monitored state
      monitored.lastHeadSha = pr.headSha;
      monitored.lastCommentCount = comments.length;
      monitored.lastReviewCount = reviews.length;
      monitored.lastFeedback = feedback;

      // Emit events
      if (hasNewFeedback) {
        monitored.lastActivityAt = new Date();
        this.emit("feedback", {
          pr,
          feedback,
          previousFeedback: previousFeedback ?? undefined,
        } as PRMonitorEventData);
      }

      if (checksChanged) {
        monitored.lastActivityAt = new Date();
        this.emit("checks_changed", { pr, feedback } as PRMonitorEventData);
      }

      // Check for inactivity timeout
      const inactivityMs = Date.now() - monitored.lastActivityAt.getTime();
      const timeoutMs = this.options.inactivityTimeoutMins * 60 * 1000;
      if (inactivityMs > timeoutMs) {
        logger.info(
          `PR ${key} inactive for ${this.options.inactivityTimeoutMins} minutes, stopping monitor`
        );
        this.stopMonitoring(monitored.url);
        return;
      }

      // Schedule next poll
      this.schedulePoll(key);
    } catch (error) {
      logger.error(`Error polling PR ${key}`, error);
      this.emit("error", {
        pr: monitored.lastFeedback?.pr ?? ({} as PullRequest),
        error: error as Error,
      } as PRMonitorEventData);

      // Continue polling despite errors
      this.schedulePoll(key);
    }
  }

  /**
   * Override emit to provide type safety
   */
  emit(event: PRMonitorEvent, data: PRMonitorEventData): boolean {
    return super.emit(event, data);
  }

  /**
   * Override on to provide type safety
   */
  on(event: PRMonitorEvent, listener: (data: PRMonitorEventData) => void): this {
    return super.on(event, listener);
  }

  /**
   * Override once to provide type safety
   */
  once(event: PRMonitorEvent, listener: (data: PRMonitorEventData) => void): this {
    return super.once(event, listener);
  }
}
