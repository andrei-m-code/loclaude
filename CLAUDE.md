# ollama-claude

## What We're Building

An AI-powered coding agent — similar to Claude Code — that runs in the terminal and uses **any LLM provider** to accomplish software engineering tasks autonomously. The agent reads/writes/edits files, runs shell commands, searches codebases, and makes HTTP requests, all driven by natural language instructions.

**Key difference from Claude Code**: Instead of being locked to one provider, this agent works with:
- **Ollama** (local models — Llama, Mistral, CodeLlama, etc.) — the initial POC target
- **OpenAI** (GPT-4, etc.) — future
- **Anthropic** (Claude) — future
- Any OpenAI-compatible API — future

**Key design decision**: Not all models support native tool/function calling. The agent auto-detects model capabilities and falls back to prompt-based tool calling (parsing `<tool_call>` blocks from plain text) for models without native support. This ensures the agent works with ANY model.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    CLI REPL (T-020)                      │
│  user input → agent → streamed response → rendered out  │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                   Agent Loop (T-017)                     │
│                                                          │
│  1. Build messages (system prompt + history + user msg)  │
│  2. Call provider.chat(messages, tools)                   │
│  3. If tool_calls → execute tools → append results → #2 │
│  4. If text → stream to CLI → done                       │
└──────────┬──────────────────────┬───────────────────────┘
           │                      │
     ┌─────▼──────┐        ┌─────▼──────────────┐
     │  Provider   │        │  Tool Registry     │
     │  Adapter    │        │  (T-006)           │
     │  (T-005)    │        │                    │
     │             │        │  file_read    bash │
     │  native ──┐ │        │  file_write   grep │
     │  fallback ┘ │        │  file_edit    glob │
     │             │        │  file_delete  http │
     │  ┌────────┐ │        └────────────────────┘
     │  │ Ollama │ │
     │  │ OpenAI │ │  (future)
     │  │ Claude │ │  (future)
     │  └────────┘ │
     └─────────────┘
```

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Node.js >= 20
- **Package Manager**: pnpm
- **Build**: tsup (esbuild-based)
- **Test**: vitest
- **Lint**: ESLint + Prettier
- **Key deps**: zod (validation), chalk (colors), ora (spinners), marked (markdown), fast-glob (file search)

## Task Breakdown

All tasks are in the `tasks/` directory as detailed markdown files (25 total, ~7100 lines of spec). Organized into phases:

### Phase 0 — Foundation
- `T-001` — Project initialization, repo scaffolding, build setup, directory structure

### Phase 1 — Config & Provider Layer
- `T-002` — Configuration system (config files, env vars, CLI flags, merge precedence)
- `T-003` — Provider abstraction layer (interface, factory, base class)
- `T-004` — Ollama provider implementation (API client, chat, tool calling, auto-pull)
- `T-005` — Tool call capability detection and prompt-based fallback

### Phase 2 — Tool System
- `T-006` — Tool system framework (BaseTool, registry, zod validation)
- `T-007` — File read tool (with binary detection, encoding handling, symlink support)
- `T-008` — File write tool (with atomic writes, path traversal protection)
- `T-009` — File edit tool (string replacement, diff generation, line ending preservation)
- `T-010` — File delete tool
- `T-011` — Glob tool (with case sensitivity, symlink loop protection)
- `T-012` — Grep tool (with multiline, binary skip, large file handling)
- `T-013` — Bash tool (shell execution, timeout, process tracking)
- `T-014` — HTTP request tool (with SSRF protection, auth patterns)

### Phase 3 — Agent Intelligence
- `T-015` — Conversation management (message history, context window, truncation)
- `T-016` — System prompt engineering (dynamic assembly, prompt budget, injection mitigation)
- `T-017` — Core agent loop (orchestration, tool execution, cancellation)
- `T-018` — Streaming support (token-by-token delivery, abort, buffering)

### Phase 4 — User Interface
- `T-019` — Terminal output rendering (markdown, syntax highlighting, diffs, tables)
- `T-020` — CLI REPL interface (input, slash commands, Ctrl+C, readline history)

### Phase 5 — Safety & Reliability
- `T-021` — Safety and permissions (ALLOW/CONFIRM/DENY, command classification, audit log)
- `T-023` — Error handling and retry (error hierarchy, exponential backoff, error formatting)
- `T-024` — Logging system (structured logs, levels, file output, redaction)
- `T-025` — Startup health checks and graceful shutdown (pre-flight, process cleanup)

### Phase 6 — Quality
- `T-022` — Testing and quality (unit/integration/E2E tests, mock provider, CI)

## Implementation Order

Tasks are numbered in dependency order. Build sequentially from T-001 to T-025:

1. **T-001** — Project init
2. **T-023** — Error handling (used by everything, build early)
3. **T-024** — Logging system (used by everything, build early)
4. **T-002** — Configuration system
5. **T-003** — Provider abstraction
6. **T-004** — Ollama provider
7. **T-005** — Tool call fallback detection
8. **T-006** — Tool system framework
9. **T-007 – T-014** — All 8 tools (can be parallelized)
10. **T-015** — Conversation management
11. **T-016** — System prompt
12. **T-017** — Agent loop (ties it all together)
13. **T-018** — Streaming
14. **T-019** — Terminal rendering
15. **T-020** — CLI REPL
16. **T-021** — Safety and permissions
17. **T-025** — Startup health checks and shutdown
18. **T-022** — Testing (ongoing throughout, formalized last)

Note: T-023 (errors) and T-024 (logging) are numbered late but should be built early — they are cross-cutting infrastructure that every other component depends on.

## Conventions

- All source code goes in `src/`
- All tests go in `tests/` mirroring the src structure
- Use absolute imports with `@/` prefix (via tsconfig paths)
- Every tool extends `BaseTool` from the tool framework (T-006)
- Every provider implements the `LLMProvider` interface (T-003)
- All errors extend `AgentError` with a unique code string (T-023)
- Config is loaded once at startup and passed via dependency injection
- Dangerous command classification lives in one place: `src/safety/command-classifier.ts` (T-021)
- File operations use atomic writes (temp file + rename) to prevent corruption
- Logging goes to stderr (never stdout) and to file in debug mode
