# T-023: Error Handling and Retry Strategy

## Status: Pending

## Priority: High

## Summary

Define and implement a unified error handling system across all components — provider errors, tool failures, network issues, invalid input, and unexpected runtime exceptions. This includes a typed error hierarchy, retry with exponential backoff for transient failures, and user-facing error formatting.

## Context

Errors come from many sources in this agent:
- **Provider**: Ollama down, model not found, timeout, rate limit, malformed response
- **Tools**: File not found, permission denied, command failed, invalid regex, HTTP error
- **Agent Loop**: Tool call parse failure, max turns exceeded, context overflow
- **Config**: Invalid config file, missing required values
- **System**: Out of memory, disk full, signal received

Without a unified strategy, each component handles errors differently, error messages are inconsistent, and retryable failures crash the agent.

## Detailed Implementation

### Error Hierarchy

```typescript
/**
 * Base error class for all agent errors.
 * Extends Error with a machine-readable code and metadata.
 */
class AgentError extends Error {
  /** Machine-readable error code for programmatic handling */
  readonly code: string;
  /** Whether this error is likely transient and retryable */
  readonly retryable: boolean;
  /** Original error that caused this one */
  readonly cause?: Error;
  /** Additional context (tool name, file path, command, etc.) */
  readonly context: Record<string, unknown>;

  constructor(options: {
    message: string;
    code: string;
    retryable?: boolean;
    cause?: Error;
    context?: Record<string, unknown>;
  }) {
    super(options.message);
    this.name = "AgentError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
    this.context = options.context ?? {};
  }
}

// --- Provider Errors ---

class ProviderError extends AgentError {
  constructor(message: string, code: string, options?: { retryable?: boolean; cause?: Error }) {
    super({ message, code: `PROVIDER_${code}`, retryable: options?.retryable, cause: options?.cause });
    this.name = "ProviderError";
  }
}

class ProviderConnectionError extends ProviderError {
  constructor(baseUrl: string, cause?: Error) {
    super(
      `Cannot connect to provider at ${baseUrl}. Is it running?`,
      "CONNECTION_FAILED",
      { retryable: true, cause },
    );
  }
}

class ProviderModelNotFoundError extends ProviderError {
  constructor(model: string) {
    super(`Model "${model}" not found. Run "ollama pull ${model}" to download it.`, "MODEL_NOT_FOUND");
  }
}

class ProviderTimeoutError extends ProviderError {
  constructor(timeoutMs: number) {
    super(`Provider request timed out after ${timeoutMs}ms`, "TIMEOUT", { retryable: true });
  }
}

class ProviderRateLimitError extends ProviderError {
  retryAfterMs?: number;
  constructor(retryAfterMs?: number) {
    super(
      `Rate limited by provider${retryAfterMs ? `. Retry after ${retryAfterMs}ms` : ""}`,
      "RATE_LIMITED",
      { retryable: true },
    );
    this.retryAfterMs = retryAfterMs;
  }
}

class ProviderResponseError extends ProviderError {
  constructor(message: string, cause?: Error) {
    super(message, "INVALID_RESPONSE", { cause });
  }
}

// --- Tool Errors ---

class ToolError extends AgentError {
  readonly toolName: string;

  constructor(toolName: string, message: string, code: string, options?: { cause?: Error; context?: Record<string, unknown> }) {
    super({
      message,
      code: `TOOL_${code}`,
      context: { toolName, ...options?.context },
      cause: options?.cause,
    });
    this.name = "ToolError";
    this.toolName = toolName;
  }
}

class ToolInputValidationError extends ToolError {
  constructor(toolName: string, details: string) {
    super(toolName, `Invalid input for ${toolName}: ${details}`, "INVALID_INPUT");
  }
}

class ToolExecutionError extends ToolError {
  constructor(toolName: string, message: string, cause?: Error) {
    super(toolName, message, "EXECUTION_FAILED", { cause });
  }
}

class ToolPermissionDeniedError extends ToolError {
  constructor(toolName: string, action: string) {
    super(toolName, `Permission denied: ${action}`, "PERMISSION_DENIED");
  }
}

class ToolNotFoundError extends ToolError {
  constructor(toolName: string) {
    super(toolName, `Unknown tool: "${toolName}"`, "NOT_FOUND");
  }
}

// --- Agent Errors ---

class AgentLoopError extends AgentError {
  constructor(message: string, code: string) {
    super({ message, code: `AGENT_${code}` });
    this.name = "AgentLoopError";
  }
}

class MaxTurnsExceededError extends AgentLoopError {
  constructor(maxTurns: number) {
    super(`Agent exceeded maximum of ${maxTurns} consecutive tool turns`, "MAX_TURNS");
  }
}

class ContextOverflowError extends AgentLoopError {
  constructor() {
    super("Conversation exceeds context window. Use /compact to summarize.", "CONTEXT_OVERFLOW");
  }
}

// --- Config Errors ---

class ConfigError extends AgentError {
  constructor(message: string) {
    super({ message, code: "CONFIG_INVALID" });
    this.name = "ConfigError";
  }
}
```

### Error Code Registry

Every error has a unique code for programmatic handling and log search:

| Code | Meaning | Retryable |
|------|---------|-----------|
| `PROVIDER_CONNECTION_FAILED` | Cannot reach provider | Yes |
| `PROVIDER_MODEL_NOT_FOUND` | Model not installed | No |
| `PROVIDER_TIMEOUT` | Request timed out | Yes |
| `PROVIDER_RATE_LIMITED` | Too many requests | Yes |
| `PROVIDER_INVALID_RESPONSE` | Malformed response | No |
| `TOOL_INVALID_INPUT` | Bad tool arguments from LLM | No |
| `TOOL_EXECUTION_FAILED` | Tool runtime error | No |
| `TOOL_PERMISSION_DENIED` | Blocked by permission system | No |
| `TOOL_NOT_FOUND` | LLM called unknown tool | No |
| `AGENT_MAX_TURNS` | Exceeded tool turn limit | No |
| `AGENT_CONTEXT_OVERFLOW` | Context window full | No |
| `CONFIG_INVALID` | Bad config value | No |

### Retry with Exponential Backoff

```typescript
interface RetryOptions {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Initial delay in ms */
  initialDelayMs: number;
  /** Maximum delay in ms */
  maxDelayMs: number;
  /** Multiplier for each retry (default: 2 for exponential) */
  backoffMultiplier: number;
  /** Add random jitter to prevent thundering herd */
  jitter: boolean;
  /** Only retry if this returns true */
  shouldRetry?: (error: Error, attempt: number) => boolean;
  /** Called before each retry (for logging) */
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
};

async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };

  let lastError: Error | undefined;
  let delay = opts.initialDelayMs;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check if error is retryable
      const isRetryable = err instanceof AgentError ? err.retryable : false;
      const shouldRetry = opts.shouldRetry?.(lastError, attempt) ?? isRetryable;

      if (!shouldRetry || attempt >= opts.maxRetries) {
        throw lastError;
      }

      // Handle rate limit with explicit retry-after
      if (err instanceof ProviderRateLimitError && err.retryAfterMs) {
        delay = err.retryAfterMs;
      }

      // Add jitter (±25%)
      const jitteredDelay = opts.jitter
        ? delay * (0.75 + Math.random() * 0.5)
        : delay;

      opts.onRetry?.(lastError, attempt + 1, jitteredDelay);

      await new Promise(resolve => setTimeout(resolve, jitteredDelay));

      // Increase delay for next attempt
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }

  throw lastError!;
}
```

### Provider-Level Retry Integration

```typescript
// In the base provider or provider wrapper:
async function chatWithRetry(
  provider: LLMProvider,
  messages: Message[],
  tools?: ToolDefinition[],
): Promise<ChatResponse> {
  return withRetry(
    () => provider.chat(messages, tools),
    {
      maxRetries: 3,
      shouldRetry: (err) => {
        // Only retry transient provider errors
        return err instanceof ProviderError && err.retryable;
      },
      onRetry: (err, attempt, delay) => {
        logger.warn(`Provider call failed (attempt ${attempt}), retrying in ${delay}ms: ${err.message}`);
      },
    },
  );
}
```

### Tool Error Handling in Agent Loop

When a tool fails, the error is reported back to the LLM as a tool result (not thrown up):

```typescript
async function executeToolSafely(
  tool: Tool,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const result = await tool.execute(args);
    return result.output;
  } catch (err) {
    if (err instanceof ToolError) {
      // Return error as text to the LLM so it can adapt
      return `ERROR [${err.code}]: ${err.message}`;
    }
    // Unexpected error — still return to LLM, but also log
    logger.error("Unexpected tool error", err);
    return `ERROR: Unexpected error executing ${tool.name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
```

### User-Facing Error Formatting

```typescript
function formatErrorForUser(err: Error): string {
  if (err instanceof ProviderConnectionError) {
    return `Connection failed: ${err.message}\n\nMake sure Ollama is running: ollama serve`;
  }
  if (err instanceof ProviderModelNotFoundError) {
    return err.message;
  }
  if (err instanceof ConfigError) {
    return `Configuration error: ${err.message}`;
  }
  if (err instanceof AgentError) {
    return `Error [${err.code}]: ${err.message}`;
  }
  // Unknown error
  return `Unexpected error: ${err.message}`;
}
```

### Global Uncaught Error Handler

```typescript
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", err);
  console.error(chalk.red("\nFatal error: " + err.message));
  if (config.ui.verbosity === "debug") {
    console.error(err.stack);
  }
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", reason);
  console.error(chalk.red("\nUnhandled error: " + String(reason)));
  process.exit(1);
});
```

## File Locations

- `src/errors/base.ts` — AgentError base class
- `src/errors/provider.ts` — Provider error types
- `src/errors/tool.ts` — Tool error types
- `src/errors/agent.ts` — Agent loop error types
- `src/errors/index.ts` — Re-exports all error types
- `src/utils/retry.ts` — Retry with backoff utility
- `src/utils/error-format.ts` — User-facing error formatter

## Acceptance Criteria

1. Every error thrown in the codebase extends AgentError.
2. Every error has a unique, searchable code string.
3. Retryable errors are marked and automatically retried.
4. Provider connection failures retry 3 times with exponential backoff.
5. Rate limit errors respect Retry-After headers.
6. Tool errors are returned to the LLM as text (not thrown).
7. User sees clean, actionable error messages (not stack traces).
8. Debug mode (`--debug`) shows full stack traces.
9. Uncaught exceptions are caught and logged before exit.
10. Unit tests for retry logic (success after N attempts, max retries exhausted, non-retryable).

## Dependencies

- T-001

## Blocks

- T-003 (Provider Abstraction uses error types)
- T-004 (Ollama Provider throws provider errors)
- T-006 (Tool Framework uses tool errors)
- T-017 (Agent Loop error handling and tool error reporting)
