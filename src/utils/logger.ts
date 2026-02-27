export enum LogLevel {
  SILENT = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
  TRACE = 5,
}

export interface Logger {
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  trace(message: string, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

export class ConsoleLogger implements Logger {
  private level: LogLevel;
  private defaultContext: Record<string, unknown>;

  constructor(options: { level?: LogLevel; context?: Record<string, unknown> } = {}) {
    this.level = options.level ?? LogLevel.WARN;
    this.defaultContext = options.context ?? {};
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    if (this.level >= LogLevel.ERROR) {
      this.write("ERROR", message, { ...context, error: error?.message });
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.level >= LogLevel.WARN) {
      this.write("WARN", message, context);
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.level >= LogLevel.INFO) {
      this.write("INFO", message, context);
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.level >= LogLevel.DEBUG) {
      this.write("DEBUG", message, context);
    }
  }

  trace(message: string, context?: Record<string, unknown>): void {
    if (this.level >= LogLevel.TRACE) {
      this.write("TRACE", message, context);
    }
  }

  child(context: Record<string, unknown>): Logger {
    return new ConsoleLogger({
      level: this.level,
      context: { ...this.defaultContext, ...context },
    });
  }

  private write(level: string, message: string, context?: Record<string, unknown>): void {
    const merged = { ...this.defaultContext, ...context };
    const contextStr = Object.keys(merged).length > 0 ? ` ${JSON.stringify(merged)}` : "";
    process.stderr.write(`[${level}] ${message}${contextStr}\n`);
  }
}

const verbosityToLevel: Record<string, LogLevel> = {
  quiet: LogLevel.ERROR,
  normal: LogLevel.WARN,
  verbose: LogLevel.INFO,
  debug: LogLevel.TRACE,
};

export function createLogger(verbosity: string = "normal"): Logger {
  return new ConsoleLogger({ level: verbosityToLevel[verbosity] ?? LogLevel.WARN });
}
