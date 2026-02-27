# T-001: Project Initialization and Architecture Design

## Status: Pending

## Priority: Critical — This is the foundation everything else builds on.

## Summary

Set up the project repository, choose the tech stack, define the directory structure, initialize the package manager, configure TypeScript, linting, and establish the high-level architectural blueprint for the agent system.

## Context

We are building an AI-powered coding agent (similar to Claude Code) that connects to local and cloud LLM providers (starting with Ollama). The agent will operate as an interactive CLI REPL that receives user instructions in natural language, reasons about them, and executes actions using a suite of tools (file I/O, shell commands, HTTP requests, code search, etc.).

The architecture must be modular enough to:
- Swap LLM providers without changing tool or agent logic.
- Add new tools without modifying the core agent loop.
- Support streaming responses from the LLM.
- Handle multi-turn conversations with tool call/result cycles.

## Tech Stack Decision

**Language:** TypeScript (Node.js)

**Rationale:**
- Excellent async/streaming support (critical for LLM streaming and shell execution).
- Rich ecosystem for CLI tools (ink, chalk, ora, readline).
- Strong typing helps manage the complexity of tool schemas and provider APIs.
- Natural fit since the reference (Claude Code) is TypeScript-based.

**Key Dependencies (initial):**
| Package | Purpose |
|---------|---------|
| `typescript` | Language |
| `tsx` | Dev runner (fast TS execution without build step) |
| `@types/node` | Node.js type definitions |
| `zod` | Runtime schema validation for tool inputs/outputs |
| `chalk` | Terminal colors |
| `ora` | Spinners for async operations |
| `marked` + `marked-terminal` | Markdown rendering in terminal |
| `highlight.js` | Syntax highlighting for code blocks |
| `readline` | Built-in Node.js REPL interface |

## Directory Structure

```
ollama-claude/
├── tasks/                    # Task tracking (this folder)
├── src/
│   ├── index.ts              # Entry point — bootstraps CLI
│   ├── cli/
│   │   ├── repl.ts           # Interactive REPL loop
│   │   ├── renderer.ts       # Terminal output rendering (markdown, code, etc.)
│   │   └── commands.ts       # Slash commands (/help, /clear, /model, etc.)
│   ├── agent/
│   │   ├── agent.ts          # Core agent loop (think → act → observe cycle)
│   │   ├── conversation.ts   # Conversation/message history management
│   │   └── planner.ts        # (Future) Multi-step planning
│   ├── providers/
│   │   ├── types.ts          # Provider interface definitions
│   │   ├── ollama.ts         # Ollama provider implementation
│   │   ├── openai.ts         # (Future) OpenAI provider
│   │   └── anthropic.ts      # (Future) Anthropic/Claude provider
│   ├── tools/
│   │   ├── registry.ts       # Tool registry — discovers and manages tools
│   │   ├── types.ts          # Tool interface, schema types
│   │   ├── file-read.ts      # Read file contents
│   │   ├── file-write.ts     # Write/create files
│   │   ├── file-edit.ts      # Edit files (string replacement)
│   │   ├── file-delete.ts    # Delete files
│   │   ├── glob.ts           # File pattern search
│   │   ├── grep.ts           # Content search (ripgrep-style)
│   │   ├── bash.ts           # Shell command execution
│   │   └── http-request.ts   # HTTP requests (fetch)
│   ├── config/
│   │   ├── config.ts         # Configuration loading and validation
│   │   └── defaults.ts       # Default configuration values
│   └── utils/
│       ├── logger.ts         # Logging utility
│       ├── errors.ts         # Custom error types
│       └── stream.ts         # Stream processing helpers
├── tests/
│   ├── agent/
│   ├── providers/
│   ├── tools/
│   └── helpers/
├── package.json
├── tsconfig.json
├── .eslintrc.json
├── .gitignore
└── README.md
```

## Acceptance Criteria

1. **Repository initialized** with `git init`, proper `.gitignore` (node_modules, dist, .env, etc.).
2. **`package.json`** created with project metadata, scripts:
   - `dev` — run with tsx in watch mode
   - `build` — compile TypeScript
   - `start` — run compiled output
   - `test` — run test suite
   - `lint` — run ESLint
3. **`tsconfig.json`** configured:
   - `target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`
   - Strict mode enabled
   - `outDir: "./dist"`, `rootDir: "./src"`
   - Path aliases if needed
4. **All directories** from the structure above created (empty placeholder files are fine for now, e.g., `// TODO: implement` exports).
5. **Core type files created** with initial interfaces:
   - `src/providers/types.ts` — `LLMProvider`, `LLMMessage`, `LLMResponse`, `ToolCall`
   - `src/tools/types.ts` — `Tool`, `ToolInput`, `ToolResult`, `ToolSchema`
6. **Entry point** (`src/index.ts`) that prints a "Hello from ollama-claude agent" message and exits, confirming the toolchain works.
7. **`npm run dev`** executes successfully.

## Implementation Notes

- Use ES modules (`"type": "module"` in package.json).
- Keep dependencies minimal at this stage — we'll add more as needed per task.
- Do NOT implement any real logic yet. This task is purely scaffolding.
- The architecture diagram above is a guide, not a rigid contract. It will evolve.

## Dependencies

- None (this is the first task).

## Blocked By

- Nothing.

## Blocks

- Every other task depends on this one.
