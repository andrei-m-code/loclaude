# T-025: Startup Validation, Health Checks, and Graceful Shutdown

## Status: Pending

## Priority: High

## Summary

Implement the full application lifecycle: pre-flight validation at startup (verify provider reachability, model availability, config sanity), runtime health monitoring, and graceful shutdown with process cleanup when the agent exits.

## Context

The agent interacts with external services (Ollama) and spawns child processes (bash tool). Without proper lifecycle management:
- The agent starts, the user types a long prompt, and THEN discovers Ollama isn't running.
- The user kills the agent mid-operation and orphan bash processes keep running.
- A long-running bash command outlives the agent session.

## Detailed Implementation

### Part 1: Startup Validation

Run pre-flight checks before showing the REPL prompt:

```typescript
interface StartupCheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
  durationMs: number;
}

async function runStartupChecks(config: Config): Promise<StartupCheckResult[]> {
  const results: StartupCheckResult[] = [];

  // 1. Check provider connectivity
  results.push(await checkProviderConnectivity(config));

  // 2. Check model availability
  results.push(await checkModelAvailable(config));

  // 3. Detect tool calling support
  results.push(await checkToolCallSupport(config));

  // 4. Check working directory permissions
  results.push(await checkWorkingDirectory());

  // 5. Validate config
  results.push(checkConfigSanity(config));

  return results;
}
```

#### Check 1: Provider Connectivity

```typescript
async function checkProviderConnectivity(config: Config): Promise<StartupCheckResult> {
  const timer = new Timer();
  try {
    if (config.provider.name === "ollama") {
      const resp = await fetch(`${config.provider.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return {
        name: "Provider connectivity",
        status: "pass",
        message: `Connected to Ollama at ${config.provider.baseUrl}`,
        durationMs: timer.elapsedMs(),
      };
    }
    // Future: OpenAI, Anthropic health checks
    return { name: "Provider connectivity", status: "pass", message: "OK", durationMs: timer.elapsedMs() };
  } catch (err) {
    return {
      name: "Provider connectivity",
      status: "fail",
      message: `Cannot connect to ${config.provider.name} at ${config.provider.baseUrl}. Is it running?\n  Try: ollama serve`,
      durationMs: timer.elapsedMs(),
    };
  }
}
```

#### Check 2: Model Availability

```typescript
async function checkModelAvailable(config: Config): Promise<StartupCheckResult> {
  const timer = new Timer();
  try {
    if (config.provider.name === "ollama") {
      const resp = await fetch(`${config.provider.baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: config.provider.model }),
        signal: AbortSignal.timeout(5000),
      });

      if (resp.ok) {
        const info = await resp.json();
        const size = info.details?.parameter_size ?? "unknown size";
        return {
          name: "Model availability",
          status: "pass",
          message: `Model "${config.provider.model}" loaded (${size})`,
          durationMs: timer.elapsedMs(),
        };
      }

      // Model not found — suggest pulling it
      return {
        name: "Model availability",
        status: "fail",
        message: `Model "${config.provider.model}" not found.\n  Try: ollama pull ${config.provider.model}`,
        durationMs: timer.elapsedMs(),
      };
    }
    return { name: "Model availability", status: "pass", message: "OK", durationMs: timer.elapsedMs() };
  } catch (err) {
    return {
      name: "Model availability",
      status: "warn",
      message: `Could not verify model: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: timer.elapsedMs(),
    };
  }
}
```

#### Check 3: Tool Call Support Detection

```typescript
async function checkToolCallSupport(config: Config): Promise<StartupCheckResult> {
  const timer = new Timer();
  // Delegates to T-005 ToolCapabilityDetector
  const detector = new ToolCapabilityDetector(getConfigDir());
  const supportsTools = await detector.detect(provider, config.provider.model, config.provider.baseUrl);

  return {
    name: "Tool call support",
    status: "pass",
    message: supportsTools
      ? "Native tool calling supported"
      : "Using prompt-based tool calling fallback",
    durationMs: timer.elapsedMs(),
  };
}
```

#### Check 4: Working Directory

```typescript
async function checkWorkingDirectory(): Promise<StartupCheckResult> {
  const timer = new Timer();
  const cwd = process.cwd();
  try {
    await fs.access(cwd, fs.constants.R_OK | fs.constants.W_OK);
    return {
      name: "Working directory",
      status: "pass",
      message: cwd,
      durationMs: timer.elapsedMs(),
    };
  } catch {
    return {
      name: "Working directory",
      status: "warn",
      message: `${cwd} (limited permissions — some file operations may fail)`,
      durationMs: timer.elapsedMs(),
    };
  }
}
```

#### Startup Display

```
 ollama-claude v0.1.0

 Checking environment...
  [pass] Provider connectivity — Connected to Ollama at http://localhost:11434 (23ms)
  [pass] Model availability — Model "llama3.1:8b" loaded (8B) (45ms)
  [pass] Tool call support — Native tool calling supported (1200ms)
  [pass] Working directory — /Users/me/projects/myapp (1ms)

 Ready. Type /help for commands.

 >
```

If any check fails:

```
 ollama-claude v0.1.0

 Checking environment...
  [FAIL] Provider connectivity — Cannot connect to Ollama at http://localhost:11434.
         Try: ollama serve
  [skip] Model availability — Skipped (provider not available)
  [skip] Tool call support — Skipped (provider not available)
  [pass] Working directory — /Users/me/projects/myapp (1ms)

 Error: Cannot start — provider is not reachable. Fix the issues above and try again.
```

Behavior on failure:
- **Connectivity fail**: Exit with error (can't do anything without a provider).
- **Model not found**: Exit with error and suggest `ollama pull`.
- **Tool support detection fail**: Continue with fallback mode (warning, not fatal).
- **Working directory warn**: Continue with warning.
- **Config invalid**: Exit with error.

### Part 2: Graceful Shutdown

#### Signal Handling

```typescript
class ShutdownManager {
  private cleanupHandlers: Array<() => Promise<void>> = [];
  private isShuttingDown = false;

  constructor() {
    // Register signal handlers
    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("SIGHUP", () => this.shutdown("SIGHUP"));
  }

  /** Register a cleanup function to run on shutdown */
  onShutdown(handler: () => Promise<void>): void {
    this.cleanupHandlers.push(handler);
  }

  private async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      // Second signal — force exit
      console.error("\nForce exiting...");
      process.exit(1);
    }

    this.isShuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully...`);

    // Run all cleanup handlers with a timeout
    const cleanupTimeout = setTimeout(() => {
      logger.error("Cleanup timed out, force exiting");
      process.exit(1);
    }, 5000);

    try {
      await Promise.allSettled(
        this.cleanupHandlers.map(handler => handler())
      );
    } catch (err) {
      logger.error("Error during cleanup", err as Error);
    }

    clearTimeout(cleanupTimeout);
    process.exit(0);
  }
}
```

#### What Gets Cleaned Up

```typescript
const shutdownManager = new ShutdownManager();

// 1. Kill all child processes spawned by the bash tool
shutdownManager.onShutdown(async () => {
  logger.debug("Killing child processes...");
  processTracker.killAll();
});

// 2. Close log file streams
shutdownManager.onShutdown(async () => {
  logger.debug("Closing log files...");
  await logger.close();
});

// 3. Flush audit log
shutdownManager.onShutdown(async () => {
  logger.debug("Flushing audit log...");
  await auditLog.flush();
});

// 4. Close readline interface
shutdownManager.onShutdown(async () => {
  rl.close();
});
```

#### Child Process Tracker

The bash tool must register all spawned processes so they can be killed on shutdown:

```typescript
class ProcessTracker {
  private processes: Set<ChildProcess> = new Set();

  track(proc: ChildProcess): void {
    this.processes.add(proc);
    proc.on("exit", () => this.processes.delete(proc));
  }

  killAll(): void {
    for (const proc of this.processes) {
      try {
        // Kill process group (handles subprocesses too)
        process.kill(-proc.pid!, "SIGTERM");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process already dead
        }
      }
    }
    this.processes.clear();
  }

  get activeCount(): number {
    return this.processes.size;
  }
}
```

### Part 3: Runtime Health Monitoring

Periodically check provider health during long sessions:

```typescript
class HealthMonitor {
  private intervalHandle?: NodeJS.Timeout;
  private lastCheckOk = true;

  start(config: Config, intervalMs: number = 60_000): void {
    this.intervalHandle = setInterval(async () => {
      try {
        const resp = await fetch(`${config.provider.baseUrl}/api/tags`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        if (!this.lastCheckOk) {
          logger.info("Provider connection restored");
          this.lastCheckOk = true;
        }
      } catch {
        if (this.lastCheckOk) {
          logger.warn("Provider connection lost — requests may fail");
          this.lastCheckOk = false;
        }
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }
}
```

## File Locations

- `src/lifecycle/startup.ts` — Pre-flight checks
- `src/lifecycle/shutdown.ts` — Graceful shutdown and cleanup
- `src/lifecycle/health.ts` — Runtime health monitoring
- `src/lifecycle/process-tracker.ts` — Child process tracking

## Acceptance Criteria

1. Startup checks run before the REPL prompt appears.
2. Provider connectivity is verified with a 5-second timeout.
3. Model availability is checked; missing model shows `ollama pull` hint.
4. Tool call support is detected and mode is displayed.
5. Fatal check failures (no provider, no model) prevent startup with clear error.
6. Non-fatal warnings (permissions, tool fallback) show warnings but continue.
7. SIGINT/SIGTERM trigger graceful shutdown.
8. All child processes are killed on shutdown.
9. Double-signal forces immediate exit.
10. Cleanup has a 5-second timeout before force exit.
11. Health monitor detects provider going down during a session.
12. Process tracker accurately tracks and cleans up spawned processes.

## Dependencies

- T-001, T-002 (Config), T-004 (Ollama Provider), T-005 (Tool Capability Detection), T-013 (Bash Tool — process tracking)

## Blocks

- T-020 (CLI REPL shows startup results and integrates shutdown)
