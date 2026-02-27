# LoClaude - Local Claude - Personal Assistant based on Local Models

An AI-powered coding agent that runs in the terminal and works with **any LLM provider** — starting with [Ollama](https://ollama.com) for fully local, private inference.

Read files, write code, run shell commands, and search codebases — all driven by natural language.

## Features

- **Local-first**: Runs against Ollama with models like Llama 3.1, Mistral, Qwen, CodeLlama — your data never leaves your machine
- **Universal tool calling**: Auto-detects whether a model supports native tool calls. Falls back to prompt-based `<tool_call>` parsing for models that don't — so it works with *any* model
- **Streaming**: Token-by-token output with animated spinner during tool execution
- **Terminal UI**: Fixed input bar at the bottom, scrolling output above (alternate screen buffer with ANSI scroll regions)
- **Model switching**: `/model` command lists local models and switches on the fly

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org) >= 20
- [pnpm](https://pnpm.io) (`npm install -g pnpm`)
- [Ollama](https://ollama.com) running locally with at least one model pulled

```bash
# Pull a model (if you haven't already)
ollama pull llama3.1
```

### Install & Run

```bash
git clone https://github.com/andrei-m-code/loclaude.git
cd loclaude
pnpm install
pnpm dev
```

### Build

```bash
pnpm build
pnpm start
```

## Usage

Once running, type natural language messages. The agent can read files, run commands, and iterate on results:

```
> read the file package.json and tell me what dependencies we have

> list all TypeScript files in src/

> run the tests and fix any failures
```

### Commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/model` | List available local Ollama models |
| `/model <name>` | Switch to a different model |
| `/clear` | Clear conversation history |
| `/tools` | List available tools |
| `/exit` | Exit the REPL |

### Keyboard Shortcuts

| Key | Action |
|---|---|
| `Enter` | Submit message |
| `Ctrl+C` | Cancel running agent / exit |
| `Ctrl+D` | Exit |
| `Ctrl+L` | Redraw screen |

## Configuration

Configuration via environment variables:

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_CLAUDE_PROVIDER` | `ollama` | LLM provider |
| `OLLAMA_CLAUDE_MODEL` | `llama3.1` | Model name |
| `OLLAMA_CLAUDE_BASE_URL` | `http://localhost:11434` | Ollama API URL |
| `OLLAMA_CLAUDE_API_KEY` | — | API key (for future providers) |
| `OLLAMA_CLAUDE_TEMPERATURE` | `0.1` | Sampling temperature |
| `OLLAMA_CLAUDE_MAX_TOKENS` | `4096` | Max response tokens |

Example:

```bash
OLLAMA_CLAUDE_MODEL=qwen2.5-coder pnpm dev
```

## Tools

The agent has access to these tools:

| Tool | Description |
|---|---|
| `file_read` | Read files with line numbers, offset/limit support |
| `bash` | Execute shell commands with timeout and output truncation |

More tools (file_write, file_edit, glob, grep, http) are specified in `tasks/` and will be added incrementally.

## Architecture

```
CLI REPL (terminal-ui.ts)
  └─ Agent Loop (agent.ts)
       ├─ Provider (ollama.ts) ─── Ollama API
       │    └─ Tool Capability Detection ─── native or fallback mode
       ├─ Tool Registry (registry.ts)
       │    ├─ file_read
       │    └─ bash
       └─ Conversation Manager (conversation.ts)
```

**Key design decision**: Not all models support native tool/function calling. The agent auto-detects model capabilities and falls back to prompt-based tool calling (parsing `<tool_call>` blocks from plain text) for models without native support.

## Project Structure

```
src/
  agent/        # Core agent loop, conversation management, system prompt
  cli/          # Terminal UI, REPL, output rendering
  config/       # Configuration types, defaults, env var loading
  errors/       # Error hierarchy (AgentError base + provider/tool/agent errors)
  providers/    # LLM provider abstraction, Ollama implementation, tool fallback
  tools/        # Tool framework (BaseTool, registry, zod schema), file_read, bash
  utils/        # Logger, retry utility
tasks/          # 25 detailed task specifications for full implementation
```

## Development

```bash
pnpm dev        # Run with tsx (hot reload)
pnpm build      # Build with tsup
pnpm test       # Run tests with vitest
pnpm lint       # Lint with ESLint
```

## Roadmap

The `tasks/` directory contains 25 detailed specs covering the full vision:

- **More tools**: file_write, file_edit, file_delete, glob, grep, http_request
- **More providers**: OpenAI, Anthropic, any OpenAI-compatible API
- **Safety**: Permission system (ALLOW/CONFIRM/DENY), command classification, audit log
- **Context management**: Token-aware truncation, conversation compaction
- **Polish**: Markdown rendering, syntax highlighting, diff coloring, readline history

## License

MIT
