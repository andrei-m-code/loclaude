# T-020: CLI REPL Interface

## Status: Pending

## Priority: High

## Summary

Implement the interactive command-line REPL (Read-Eval-Print Loop) that serves as the primary user interface for the agent. The user types messages, the agent responds with streamed text, and tool calls are displayed as they execute. This is the "face" of the application — it must feel responsive and polished.

## Context

The CLI REPL is the only user interface for this project (no web UI, no API server — just a terminal). It must:
- Accept multi-line user input.
- Stream assistant responses token-by-token (not wait for full response).
- Display tool calls and their results clearly.
- Show spinners/progress indicators during long operations.
- Handle Ctrl+C gracefully (cancel current operation, not exit).
- Support special commands (`/exit`, `/clear`, `/help`, `/model`, etc.).

## Detailed Implementation

### REPL Flow

```
┌──────────────────────────────────────────────────┐
│  ollama-claude v0.1.0                            │
│  Provider: ollama | Model: llama3.1              │
│  Type /help for commands, Ctrl+C to cancel       │
├──────────────────────────────────────────────────┤
│                                                  │
│  > Tell me about this project                    │
│                                                  │
│  I'll look at the project structure first.       │
│                                                  │
│  ┌─ glob ───────────────────────────────────┐    │
│  │ Pattern: **/*                            │    │
│  │ Found 12 files                           │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌─ file_read ──────────────────────────────┐    │
│  │ File: package.json                       │    │
│  │ Read 45 lines                            │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  This is a TypeScript project that...            │
│                                                  │
│  > _                                             │
└──────────────────────────────────────────────────┘
```

### User Input Handling

```typescript
class InputHandler {
  private rl: readline.Interface;

  /**
   * Read a single user message.
   * Supports multi-line input:
   * - Single Enter submits the message.
   * - Backslash + Enter (\↵) continues to next line.
   * - Empty input is ignored.
   */
  async readMessage(): Promise<string | null> {
    return new Promise((resolve) => {
      this.rl.question(chalk.green("> "), (answer) => {
        if (answer === null) {
          resolve(null); // EOF (Ctrl+D)
          return;
        }
        resolve(answer.trim());
      });
    });
  }
}
```

### Slash Commands

Built-in commands that the user can type instead of a message:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands and usage tips |
| `/exit` or `/quit` | Exit the REPL |
| `/clear` | Clear conversation history and screen |
| `/model <name>` | Switch to a different model (e.g., `/model codellama`) |
| `/provider <name>` | Switch provider (future) |
| `/system <text>` | Override the system prompt |
| `/history` | Show conversation history summary |
| `/tokens` | Show estimated token usage |
| `/tools` | List available tools |
| `/compact` | Summarize the conversation to free up context space |
| `/save [path]` | Save conversation history to a JSON file |
| `/load [path]` | Load a previous conversation from a JSON file |

### Readline History

User input history (previous commands/messages) is persisted across sessions:

- History file: `~/.config/ollama-claude/history`
- Max entries: 1000
- History is loaded on startup and saved on exit.

```typescript
const historyFile = path.join(getConfigDir(), "history");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  history: loadHistory(historyFile),
  historySize: 1000,
});

// On shutdown:
saveHistory(historyFile, rl.history);
```

### Streaming Output

The agent's text response must be streamed token-by-token:

```typescript
class OutputRenderer {
  /**
   * Stream tokens to the terminal as they arrive.
   * Uses raw stdout.write for streaming (not console.log which adds newlines).
   */
  async streamTokens(tokenStream: AsyncIterable<string>): Promise<string> {
    let fullText = "";
    for await (const token of tokenStream) {
      process.stdout.write(token);
      fullText += token;
    }
    process.stdout.write("\n");
    return fullText;
  }

  /**
   * Display a tool call being executed.
   * Shows a bordered box with tool name, inputs (summary), and result (summary).
   */
  displayToolCall(toolName: string, inputs: Record<string, unknown>): void {
    // Show tool name and key input parameters
    // Use chalk for styling, box-drawing characters for borders
    const header = chalk.cyan(`── ${toolName} `).padEnd(50, "─");
    console.log(header);

    // Show abbreviated inputs (not the full JSON — too verbose)
    const summary = this.summarizeToolInputs(toolName, inputs);
    console.log(chalk.dim(summary));
  }

  displayToolResult(toolName: string, result: string): void {
    // Show abbreviated result
    const abbreviated = result.length > 200
      ? result.slice(0, 200) + "..."
      : result;
    console.log(chalk.dim(abbreviated));
    console.log(chalk.cyan("─".repeat(50)));
    console.log();
  }

  /**
   * Smart input summarization per tool type.
   * Don't dump the full file contents — show key params.
   */
  private summarizeToolInputs(toolName: string, inputs: Record<string, unknown>): string {
    switch (toolName) {
      case "file_read":
        return `Reading: ${inputs.file_path}`;
      case "file_write":
        return `Writing: ${inputs.file_path} (${(inputs.content as string)?.length ?? 0} chars)`;
      case "file_edit":
        return `Editing: ${inputs.file_path}`;
      case "bash":
        return `$ ${inputs.command}`;
      case "glob":
        return `Pattern: ${inputs.pattern}`;
      case "grep":
        return `Searching: "${inputs.pattern}"`;
      case "http_request":
        return `${inputs.method ?? "GET"} ${inputs.url}`;
      default:
        return JSON.stringify(inputs).slice(0, 100);
    }
  }
}
```

### Ctrl+C Handling

```typescript
// Ctrl+C during streaming: cancel the current LLM call, show what we have so far
// Ctrl+C at the prompt: show "Type /exit to quit"
// Double Ctrl+C: force exit

let ctrlCCount = 0;
process.on("SIGINT", () => {
  if (isStreaming) {
    // Cancel the current provider call
    currentAbortController?.abort();
    console.log(chalk.yellow("\n[Cancelled]"));
    isStreaming = false;
    ctrlCCount = 0;
  } else {
    ctrlCCount++;
    if (ctrlCCount >= 2) {
      console.log(chalk.yellow("\nExiting..."));
      process.exit(0);
    }
    console.log(chalk.dim("\nType /exit to quit, or press Ctrl+C again to force exit."));
    // Reset after 2 seconds
    setTimeout(() => { ctrlCCount = 0; }, 2000);
  }
});
```

### Spinner for Long Operations

Use `ora` for spinner during tool execution:

```typescript
import ora from "ora";

async function executeToolWithSpinner(tool: Tool, input: unknown): Promise<string> {
  const spinner = ora({
    text: `Running ${tool.name}...`,
    color: "cyan",
  }).start();

  try {
    const result = await tool.execute(input);
    spinner.succeed(`${tool.name} completed`);
    return result.output;
  } catch (err) {
    spinner.fail(`${tool.name} failed`);
    throw err;
  }
}
```

### Banner

```
 ╔═══════════════════════════════════════════╗
 ║  ollama-claude v0.1.0                    ║
 ║  Provider: ollama | Model: llama3.1      ║
 ║  Type /help for commands                 ║
 ╚═══════════════════════════════════════════╝
```

### Main REPL Loop

```typescript
async function repl(agent: Agent, renderer: OutputRenderer): Promise<void> {
  const input = new InputHandler();

  renderer.displayBanner();

  while (true) {
    const userMessage = await input.readMessage();

    if (userMessage === null) break;        // EOF
    if (userMessage === "") continue;        // Empty
    if (userMessage.startsWith("/")) {
      const handled = await handleSlashCommand(userMessage, agent, renderer);
      if (handled === "exit") break;
      continue;
    }

    // Send to agent and stream response
    try {
      await agent.run(userMessage, {
        onToken: (token) => process.stdout.write(token),
        onToolCall: (name, inputs) => renderer.displayToolCall(name, inputs),
        onToolResult: (name, result) => renderer.displayToolResult(name, result),
      });
      console.log(); // Newline after streamed response
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
    }
  }

  console.log(chalk.dim("Goodbye!"));
  process.exit(0);
}
```

## File Locations

- `src/cli/repl.ts` — Main REPL loop
- `src/cli/input.ts` — User input handling
- `src/cli/output.ts` — Output rendering (streaming, tool display, banner)
- `src/cli/commands.ts` — Slash command handlers

## Acceptance Criteria

1. REPL starts and displays banner with provider/model info.
2. User can type messages and receive streamed responses.
3. Tool calls are displayed with clear visual boundaries.
4. Slash commands work (`/help`, `/exit`, `/clear`, `/model`, `/history`, `/tools`).
5. Ctrl+C cancels current operation without exiting.
6. Double Ctrl+C exits.
7. Ctrl+D (EOF) exits gracefully.
8. Empty input is ignored.
9. Spinner shows during tool execution.
10. Long tool outputs are abbreviated in display.

## Dependencies

- T-001, T-017 (Agent Loop), T-019 (Terminal Rendering)

## Blocks

- None — this is the user-facing entry point.
