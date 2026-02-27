# T-013: Bash / Shell Command Execution Tool

## Status: Pending

## Priority: Critical

## Summary

Implement the `bash` tool that allows the agent to execute arbitrary shell commands. This is one of the most powerful and dangerous tools — it enables the agent to run builds, tests, install dependencies, use git, and perform any system operation. It must include safety mechanisms, timeouts, and output handling.

## Context

The agent needs to:
- Run builds: `npm run build`, `cargo build`, `go build`
- Run tests: `npm test`, `pytest`, `go test ./...`
- Install packages: `npm install`, `pip install`
- Use version control: `git status`, `git diff`, `git commit`
- Inspect the system: `which node`, `node --version`, `ls -la`
- Run arbitrary commands as part of multi-step tasks

This is the "escape hatch" tool — if no specialized tool exists for something, the agent can fall back to bash.

## Detailed Implementation

### Tool Specification

| Property | Value |
|----------|-------|
| Name | `bash` |
| Description | "Execute a shell command and return its output (stdout and stderr). Use this for running builds, tests, git commands, package management, and any other shell operations." |

### Input Schema

```typescript
const inputSchema = z.object({
  command: z.string()
    .describe("The shell command to execute"),
  timeout: z.number().int().min(1000).max(600000).optional().default(120000)
    .describe("Timeout in milliseconds. Default: 120000 (2 minutes). Max: 600000 (10 minutes)."),
  working_directory: z.string().optional()
    .describe("Working directory for the command. Defaults to the current working directory."),
});
```

### Behavior

1. **Parse the command** — the command is passed to the shell as-is (via `sh -c` or the user's default shell).
2. **Set up execution environment**:
   - Working directory: provided or `process.cwd()`.
   - Inherit environment variables from the parent process.
   - Set up timeout.
3. **Execute** using `child_process.spawn` (not `exec`, to avoid buffer limits).
4. **Capture output** — both stdout and stderr, interleaved in order.
5. **Handle completion**:
   - Normal exit → return output with exit code.
   - Timeout → kill process, return partial output with timeout error.
   - Signal (SIGTERM, SIGKILL) → return with signal info.
6. **Truncate output** — if output exceeds a limit (e.g., 100KB), truncate and note.

### Output Format

Success (exit code 0):
```
$ npm test

> project@1.0.0 test
> jest

PASS  tests/tools/file-read.test.ts
PASS  tests/tools/file-write.test.ts

Test Suites: 2 passed, 2 total
Tests:       15 passed, 15 total

[Exit code: 0]
```

Failure (non-zero exit code):
```
$ npm run build

> project@1.0.0 build
> tsc

src/index.ts(15,3): error TS2322: Type 'string' is not assignable to type 'number'.

[Exit code: 1]
```

Timeout:
```
$ long-running-command

... (partial output) ...

[Error: Command timed out after 120 seconds. Process killed.]
```

### Safety Mechanisms

#### Dangerous Command Detection

**Important**: The bash tool itself does NOT block or classify commands. That is the job of the permission system (T-021), which classifies commands as ALLOW / CONFIRM / DENY before the bash tool ever executes.

The bash tool's only responsibility is execution. By the time a command reaches `bash.execute()`, the permission system has already approved it (either automatically or via user confirmation).

The shared command classification logic lives in `src/safety/command-classifier.ts` (defined in T-021) and is used by the permission system. The bash tool imports nothing from that module — it receives pre-approved commands and runs them.

This separation of concerns ensures:
- One source of truth for command classification (T-021).
- The bash tool stays simple — execute and return output.
- No duplicated pattern lists that can drift apart.

#### Output Limits

- **Max output size**: 100KB. Truncate and append `"... (output truncated, showing first 100KB of {total}KB)"`.
- **Max lines**: 2000. Truncate similarly.
- Store the full output in metadata for potential retrieval.

#### Process Cleanup

- Track spawned processes.
- On timeout, send SIGTERM first, wait 5 seconds, then SIGKILL.
- Clean up child processes when the agent exits.

### Implementation

```typescript
import { spawn } from "child_process";

class BashTool extends BaseTool<BashInput> {
  readonly name = "bash";
  readonly description = "Execute a shell command and return its output (stdout and stderr).";

  readonly inputSchema = z.object({
    command: z.string().describe("The shell command to execute"),
    timeout: z.number().int().min(1000).max(600000).optional().default(120000)
      .describe("Timeout in milliseconds (default: 120000)"),
    working_directory: z.string().optional()
      .describe("Working directory for the command"),
  });

  private maxOutputBytes = 100 * 1024; // 100KB
  private activeProcesses = new Set<ChildProcess>();

  async execute(input: BashInput): Promise<ToolResult> {
    const { command, timeout, working_directory } = input;
    const cwd = working_directory ?? process.cwd();

    // Validate working directory
    if (working_directory) {
      try {
        const stat = await fs.stat(working_directory);
        if (!stat.isDirectory()) {
          return { output: `Error: Not a directory: ${working_directory}` };
        }
      } catch {
        return { output: `Error: Directory not found: ${working_directory}` };
      }
    }

    // Check for dangerous patterns (warn but don't block)
    const warnings = this.checkDangerousPatterns(command);

    return new Promise((resolve) => {
      const proc = spawn("sh", ["-c", command], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.activeProcesses.add(proc);

      let output = "";
      let totalBytes = 0;
      let truncated = false;

      const appendOutput = (data: Buffer) => {
        const text = data.toString("utf-8");
        totalBytes += data.length;

        if (!truncated) {
          if (totalBytes <= this.maxOutputBytes) {
            output += text;
          } else {
            output += text.slice(0, this.maxOutputBytes - (totalBytes - data.length));
            truncated = true;
          }
        }
      };

      proc.stdout?.on("data", appendOutput);
      proc.stderr?.on("data", appendOutput);

      // Timeout handling
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      }, timeout);

      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        this.activeProcesses.delete(proc);

        let result = `$ ${command}\n\n${output}`;

        if (truncated) {
          result += `\n\n... (output truncated, showing first ${Math.round(this.maxOutputBytes / 1024)}KB of ${Math.round(totalBytes / 1024)}KB)`;
        }

        if (signal === "SIGTERM" || signal === "SIGKILL") {
          result += `\n\n[Error: Command timed out after ${timeout / 1000} seconds. Process killed.]`;
        } else {
          result += `\n\n[Exit code: ${code}]`;
        }

        if (warnings.length > 0) {
          result = `⚠ Warning: ${warnings.join(", ")}\n\n` + result;
        }

        resolve({
          output: result,
          metadata: {
            exitCode: code,
            signal,
            truncated,
            totalBytes,
            timedOut: signal === "SIGTERM" || signal === "SIGKILL",
          },
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        this.activeProcesses.delete(proc);
        resolve({
          output: `Error executing command: ${err.message}`,
          metadata: { error: err.message },
        });
      });
    });
  }

  private checkDangerousPatterns(command: string): string[] {
    const warnings: string[] = [];
    // ... check against DANGEROUS_PATTERNS
    return warnings;
  }

  /** Kill all active processes (for cleanup on agent exit) */
  cleanup(): void {
    for (const proc of this.activeProcesses) {
      proc.kill("SIGTERM");
    }
  }
}
```

### Shell Selection

The shell used to execute commands is configurable:

- Default: Use the user's `$SHELL` environment variable (typically `/bin/bash` or `/bin/zsh`).
- Fallback: `/bin/sh` if `$SHELL` is not set.
- Always pass `-c` flag to execute the command string.
- Override via config: `tools.bash.shell` (e.g., `"/bin/bash"`).

### Stdin Handling

Commands are spawned with stdin set to `"ignore"` to prevent interactive prompts from hanging:

```typescript
const proc = spawn(shell, ["-c", command], {
  stdin: "ignore",  // No interactive input
  // ...
});
```

If a command requires interactive input (e.g., `ssh`, `sudo`), it will fail with an appropriate error. The agent should use non-interactive alternatives (e.g., `ssh -o BatchMode=yes`).

### Environment Variables

The bash tool inherits the parent process environment. Additionally, it should set:
- `TERM=dumb` — prevent commands from using terminal escape sequences.
- `NO_COLOR=1` — disable colored output from tools that support it (cleaner for the LLM).
- `CI=true` — some tools behave better in CI mode (no interactive prompts).

## File Location

- `src/tools/bash.ts`

## Acceptance Criteria

1. Commands execute correctly with proper stdout/stderr capture.
2. Exit codes are reported.
3. Timeout mechanism works (process killed after timeout).
4. Output truncation works for large outputs.
5. Working directory parameter works.
6. Dangerous command patterns are detected and warned.
7. Process cleanup works on agent exit.
8. Environment variables are properly inherited and supplemented.
9. Unit tests:
   - Simple command execution (`echo hello`)
   - Command with non-zero exit code
   - Timeout test (sleep command)
   - Large output truncation
   - Working directory
10. Integration tests with real commands.

## Dependencies

- T-001, T-006

## Blocks

- None directly, but critical for real-world agent usage.
