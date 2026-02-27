# T-024: Logging System

## Status: Pending

## Priority: Medium

## Summary

Implement a structured logging system with configurable log levels, output destinations, and context enrichment. Logging is separate from user-facing output — logs are for debugging and diagnostics, while the CLI renderer (T-019) handles user output.

## Context

During development and production use, we need visibility into:
- Provider API calls (request/response, latency, token usage)
- Tool executions (what was called, how long it took, success/failure)
- Agent loop decisions (tool calls chosen, fallback mode, truncation)
- Configuration loading (which sources, merge results)
- Permission checks (what was allowed/denied)
- Errors and warnings with full context

Without logging, debugging issues requires adding `console.log` everywhere and recompiling.

## Detailed Implementation

### Log Levels

```typescript
enum LogLevel {
  /** Completely silent */
  SILENT = 0,
  /** Fatal errors that crash the agent */
  ERROR = 1,
  /** Recoverable issues, degraded behavior */
  WARN = 2,
  /** Key lifecycle events (startup, shutdown, model switch) */
  INFO = 3,
  /** Detailed operational info (tool calls, provider requests) */
  DEBUG = 4,
  /** Everything including raw payloads */
  TRACE = 5,
}
```

### Logger Interface

```typescript
interface Logger {
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  trace(message: string, context?: Record<string, unknown>): void;

  /** Create a child logger with additional default context */
  child(context: Record<string, unknown>): Logger;
}
```

### Logger Implementation

```typescript
class ConsoleLogger implements Logger {
  private level: LogLevel;
  private defaultContext: Record<string, unknown>;
  private outputToFile: boolean;
  private logFilePath?: string;
  private fileStream?: fs.WriteStream;

  constructor(options: {
    level: LogLevel;
    context?: Record<string, unknown>;
    logFile?: string;
  }) {
    this.level = options.level;
    this.defaultContext = options.context ?? {};

    if (options.logFile) {
      this.outputToFile = true;
      this.logFilePath = options.logFile;
      this.fileStream = fs.createWriteStream(options.logFile, { flags: "a" });
    }
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    if (this.level < LogLevel.ERROR) return;
    this.emit("ERROR", message, { ...context, error: error?.message, stack: error?.stack });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.level < LogLevel.WARN) return;
    this.emit("WARN", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.level < LogLevel.INFO) return;
    this.emit("INFO", message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.level < LogLevel.DEBUG) return;
    this.emit("DEBUG", message, context);
  }

  trace(message: string, context?: Record<string, unknown>): void {
    if (this.level < LogLevel.TRACE) return;
    this.emit("TRACE", message, context);
  }

  child(context: Record<string, unknown>): Logger {
    return new ConsoleLogger({
      level: this.level,
      context: { ...this.defaultContext, ...context },
      logFile: this.logFilePath,
    });
  }

  private emit(level: string, message: string, context?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.defaultContext,
      ...context,
    };

    if (this.fileStream) {
      // File output: structured JSON, one line per entry
      this.fileStream.write(JSON.stringify(entry) + "\n");
    }

    if (this.level >= LogLevel.DEBUG) {
      // Console output: only in debug/trace modes, to stderr (not stdout)
      const color = LEVEL_COLORS[level] ?? chalk.white;
      const contextStr = context ? ` ${chalk.dim(JSON.stringify(context))}` : "";
      process.stderr.write(`${chalk.dim(entry.timestamp)} ${color(`[${level}]`)} ${message}${contextStr}\n`);
    }
  }
}

const LEVEL_COLORS: Record<string, chalk.Chalk> = {
  ERROR: chalk.red,
  WARN: chalk.yellow,
  INFO: chalk.blue,
  DEBUG: chalk.gray,
  TRACE: chalk.dim,
};

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  [key: string]: unknown;
}
```

### Component-Specific Loggers

Each component creates a child logger with its name:

```typescript
// Provider
const providerLogger = logger.child({ component: "provider", provider: "ollama" });
providerLogger.debug("Sending chat request", { model, messageCount: messages.length });

// Tool execution
const toolLogger = logger.child({ component: "tool" });
toolLogger.debug("Executing tool", { tool: "file_read", path: "/src/index.ts" });
toolLogger.debug("Tool completed", { tool: "file_read", durationMs: 12, outputSize: 450 });

// Agent loop
const agentLogger = logger.child({ component: "agent" });
agentLogger.info("Agent turn", { turn: 3, toolCalls: 2 });
agentLogger.warn("Approaching context limit", { usedTokens: 7500, maxTokens: 8192 });

// Permission
const permLogger = logger.child({ component: "permissions" });
permLogger.info("Permission check", { tool: "bash", command: "npm install", decision: "confirm" });
```

### Log Level Mapping from Config

```typescript
function logLevelFromVerbosity(verbosity: string): LogLevel {
  switch (verbosity) {
    case "quiet": return LogLevel.ERROR;
    case "normal": return LogLevel.WARN;
    case "verbose": return LogLevel.INFO;
    case "debug": return LogLevel.TRACE;
    default: return LogLevel.WARN;
  }
}
```

### Log File Location

Default log file: `~/.config/ollama-claude/logs/agent.log`

- Logs rotate automatically (new file per day or per session).
- Old logs are cleaned up after 7 days.
- Log file path is configurable via `--log-file` flag or config.

```typescript
function getLogFilePath(): string {
  const configDir = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  const logDir = path.join(configDir, "ollama-claude", "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  return path.join(logDir, `agent-${date}.log`);
}
```

### Sensitive Data Redaction

Never log API keys, passwords, or file contents in full:

```typescript
function redact(context: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...context };
  const sensitiveKeys = ["apiKey", "api_key", "password", "token", "secret", "authorization"];

  for (const key of Object.keys(redacted)) {
    if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
      redacted[key] = "[REDACTED]";
    }
    // Truncate large string values (file contents, etc.)
    if (typeof redacted[key] === "string" && (redacted[key] as string).length > 500) {
      redacted[key] = (redacted[key] as string).slice(0, 500) + `... (${(redacted[key] as string).length} chars)`;
    }
  }

  return redacted;
}
```

### Performance Timing Helper

```typescript
class Timer {
  private start: bigint;

  constructor() {
    this.start = process.hrtime.bigint();
  }

  elapsedMs(): number {
    const elapsed = process.hrtime.bigint() - this.start;
    return Number(elapsed / 1_000_000n);
  }
}

// Usage:
const timer = new Timer();
const result = await provider.chat(messages, tools);
logger.debug("Provider call completed", { durationMs: timer.elapsedMs(), model });
```

## File Locations

- `src/utils/logger.ts` — Logger implementation
- `src/utils/timer.ts` — Performance timing helper

## Acceptance Criteria

1. Logger supports ERROR, WARN, INFO, DEBUG, TRACE levels.
2. Log level is controlled by `--verbose` / `--debug` flags and config.
3. File logging writes structured JSON, one entry per line.
4. Console logging goes to stderr (not stdout) in debug mode only.
5. Child loggers inherit parent context and add their own.
6. Sensitive data (API keys, passwords) is never logged.
7. Large values (file contents) are truncated in logs.
8. Log files are stored in `~/.config/ollama-claude/logs/`.
9. Timer helper accurately measures operation duration.
10. Normal mode (`--verbose` not set) produces zero console log output.

## Dependencies

- T-001, T-002 (config determines log level)

## Blocks

- All components use the logger, but it's injected — not a hard dependency.
