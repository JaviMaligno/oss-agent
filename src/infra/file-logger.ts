import { mkdirSync, appendFileSync, existsSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { LoggingConfig } from "../types/config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface FileLoggerOptions {
  config: LoggingConfig;
  dataDir: string;
  sessionId?: string;
}

/**
 * File-based logger for persistent logging to disk.
 * Creates daily log files and supports automatic cleanup.
 */
export class FileLogger {
  private logDir: string;
  private currentLogFile: string;
  private level: LogLevel;
  private sessionId: string;

  constructor(options: FileLoggerOptions) {
    this.logDir = join(options.dataDir, options.config.dir);
    this.level = options.config.fileLevel;
    this.sessionId = options.sessionId ?? this.generateSessionId();

    // Ensure log directory exists
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }

    // Set up daily log file
    this.currentLogFile = this.getLogFilePath();

    // Run cleanup on initialization (async, don't block)
    this.cleanup(options.config.retentionDays).catch(() => {
      // Ignore cleanup errors
    });
  }

  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private getLogFilePath(): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return join(this.logDir, `oss-agent-${date}.log`);
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  private formatMessage(level: LogLevel, message: string, data?: Record<string, unknown>): string {
    const timestamp = this.formatTimestamp();
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";
    return `[${timestamp}] [${level.toUpperCase().padEnd(5)}] [${this.sessionId}] ${message}${dataStr}\n`;
  }

  private write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const formatted = this.formatMessage(level, message, data);

    try {
      // Check if we need to rotate to a new day
      const expectedPath = this.getLogFilePath();
      if (expectedPath !== this.currentLogFile) {
        this.currentLogFile = expectedPath;
      }

      appendFileSync(this.currentLogFile, formatted);
    } catch {
      // Ignore write errors - don't want logging to break the app
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.write("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.write("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.write("warn", message, data);
  }

  error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void {
    const errorData = {
      ...data,
      ...(error instanceof Error
        ? { errorMessage: error.message, errorStack: error.stack }
        : { error: String(error) }),
    };
    this.write("error", message, errorData);
  }

  /**
   * Log a raw block of text (e.g., CLI output)
   */
  raw(content: string): void {
    try {
      appendFileSync(this.currentLogFile, content);
    } catch {
      // Ignore
    }
  }

  /**
   * Get path to the current log file
   */
  getCurrentLogFile(): string {
    return this.currentLogFile;
  }

  /**
   * Get the session ID for this logger instance
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Clean up old log files
   */
  async cleanup(retentionDays: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    let deletedCount = 0;

    try {
      const files = readdirSync(this.logDir);

      for (const file of files) {
        if (!file.startsWith("oss-agent-") || !file.endsWith(".log")) {
          continue;
        }

        const filePath = join(this.logDir, file);
        const stats = statSync(filePath);

        if (stats.mtime < cutoffDate) {
          unlinkSync(filePath);
          deletedCount++;
        }
      }
    } catch {
      // Ignore cleanup errors
    }

    return deletedCount;
  }
}

// Session log file for a specific operation
export class SessionFileLogger extends FileLogger {
  private sessionLogFile: string;

  constructor(options: FileLoggerOptions & { operationName: string }) {
    super(options);

    // Create a dedicated log file for this session/operation
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.sessionLogFile = join(
      options.dataDir,
      options.config.dir,
      "sessions",
      `${options.operationName}-${timestamp}-${this.getSessionId()}.log`
    );

    // Ensure sessions directory exists
    const sessionsDir = join(options.dataDir, options.config.dir, "sessions");
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }
  }

  /**
   * Write to the session-specific log file
   */
  session(message: string, data?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";
    const formatted = `[${timestamp}] ${message}${dataStr}\n`;

    try {
      appendFileSync(this.sessionLogFile, formatted);
    } catch {
      // Ignore
    }
  }

  /**
   * Get path to the session-specific log file
   */
  getSessionLogFile(): string {
    return this.sessionLogFile;
  }
}
