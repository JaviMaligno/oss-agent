import pc from "picocolors";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LoggerOptions {
  level: LogLevel;
  verbose: boolean;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private level: LogLevel = "info";
  private verbose = false;

  configure(options: Partial<LoggerOptions>): void {
    if (options.level !== undefined) {
      this.level = options.level;
    }
    if (options.verbose !== undefined) {
      this.verbose = options.verbose;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private formatTimestamp(): string {
    return new Date().toISOString().slice(11, 19);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog("debug")) return;
    const prefix = pc.gray(`[${this.formatTimestamp()}] ${pc.dim("DEBUG")}`);
    console.error(`${prefix} ${message}`, data ? pc.gray(JSON.stringify(data)) : "");
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog("info")) return;
    const prefix = pc.blue(`[${this.formatTimestamp()}]`) + " " + pc.cyan("INFO");
    console.error(
      `${prefix}  ${message}`,
      data && this.verbose ? pc.gray(JSON.stringify(data)) : ""
    );
  }

  success(message: string): void {
    if (!this.shouldLog("info")) return;
    const prefix = pc.green(`[${this.formatTimestamp()}]`) + " " + pc.green("✓");
    console.error(`${prefix} ${message}`);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog("warn")) return;
    const prefix = pc.yellow(`[${this.formatTimestamp()}]`) + " " + pc.yellow("WARN");
    console.warn(`${prefix}  ${message}`, data ? pc.yellow(JSON.stringify(data)) : "");
  }

  error(message: string, error?: Error | unknown): void {
    if (!this.shouldLog("error")) return;
    const prefix = pc.red(`[${this.formatTimestamp()}]`) + " " + pc.red("ERROR");
    console.error(`${prefix} ${message}`);
    if (error instanceof Error && this.verbose) {
      console.error(pc.red(error.stack ?? error.message));
    }
  }

  // Special formatting for CLI output
  header(text: string): void {
    console.error("");
    console.error(pc.bold(pc.cyan(`═══ ${text} ═══`)));
    console.error("");
  }

  step(step: number, total: number, message: string): void {
    const prefix = pc.dim(`[${step}/${total}]`);
    console.error(`${prefix} ${message}`);
  }

  cost(amount: number, label?: string): void {
    const formatted = `$${amount.toFixed(4)}`;
    const msg = label ? `${label}: ${pc.yellow(formatted)}` : pc.yellow(formatted);
    console.error(pc.dim("💰") + " " + msg);
  }
}

export const logger = new Logger();
