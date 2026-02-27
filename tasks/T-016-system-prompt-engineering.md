# T-016: System Prompt Engineering

## Status: Pending

## Priority: High

## Summary

Design and implement the system prompt that defines the agent's behavior, capabilities, and constraints. The system prompt is the single most important piece of text in the entire project — it determines how effectively the LLM uses tools, how it communicates, and how safe its actions are.

## Context

Unlike Claude Code (which uses Claude — a model trained specifically for tool use and coding), our agent uses general-purpose models (Llama, Mistral, etc.) via Ollama. These models may not be as naturally inclined toward structured tool use. The system prompt must clearly teach the model:
1. What it is and what it can do.
2. How to use each tool (when, why, what format).
3. Safety rules and constraints.
4. Communication style.

## Detailed Implementation

### System Prompt Builder

The system prompt is not static — it's assembled dynamically based on:
- Available tools
- Current working directory
- User configuration
- Provider/model capabilities

```typescript
class SystemPromptBuilder {
  build(options: {
    tools: ToolDefinition[];
    workingDirectory: string;
    providerName: string;
    modelName: string;
    userInstructions?: string;
  }): string {
    const sections: string[] = [];

    sections.push(this.buildIdentitySection(options));
    sections.push(this.buildCapabilitiesSection(options.tools));
    sections.push(this.buildToolUsageSection(options.tools));
    sections.push(this.buildRulesSection());
    sections.push(this.buildEnvironmentSection(options));

    if (options.userInstructions) {
      sections.push(this.buildUserInstructionsSection(options.userInstructions));
    }

    return sections.join("\n\n");
  }
}
```

### Prompt Sections

#### 1. Identity

```
You are an AI coding assistant running in a terminal. You help users with software engineering tasks by reading, writing, and editing code, running commands, searching codebases, and making HTTP requests.

You are powered by ${modelName} via ${providerName}.
```

#### 2. Capabilities

```
You have access to the following tools to interact with the user's system:

- file_read: Read the contents of a file
- file_write: Create a new file or overwrite an existing file
- file_edit: Make targeted edits to existing files using string replacement
- file_delete: Delete files or empty directories
- glob: Find files by name pattern
- grep: Search file contents with regex
- bash: Execute shell commands
- http_request: Make HTTP requests

IMPORTANT: You MUST use these tools to interact with the filesystem and system. Do NOT guess file contents or command outputs — always use the appropriate tool to get real data.
```

#### 3. Tool Usage Guidelines

This is the longest and most important section. For each tool, explain:
- When to use it vs alternatives
- Common patterns
- What to avoid

```
## Tool Usage Guidelines

### Reading Code
- ALWAYS read a file before editing it. Never edit blind.
- Use `glob` to find files by name when you don't know the exact path.
- Use `grep` to find where something is defined or used.
- Use `file_read` to read specific files once you know the path.

### Editing Code
- PREFER `file_edit` over `file_write` for modifying existing files.
  - file_edit only changes what you specify — it's safer.
  - file_write replaces the entire file — risk of losing code you didn't include.
- When using file_edit, include enough context in old_string to make the match unique.
- NEVER guess the current content of a file. Read it first, then edit.

### Running Commands
- Use `bash` for builds, tests, git, package management, and system commands.
- Always check command exit codes in the output.
- If a command fails, read the error output and try to fix the issue.
- Prefer non-interactive commands. Do not run commands that require user input.

### Creating Files
- Use `file_write` to create new files.
- Before creating a file, check if it already exists using `file_read` or `glob`.

### Searching
- Use `glob` for finding files by name pattern.
- Use `grep` for finding content within files.
- Start broad, then narrow down.

### HTTP Requests
- Use `http_request` for fetching web content, testing APIs, downloading files.
- Always check the response status code.
```

#### 4. Rules and Safety

```
## Rules

1. NEVER make destructive changes without reading the current state first.
2. NEVER run `rm -rf /` or similar destructive commands on system directories.
3. When editing code, preserve existing functionality unless explicitly asked to change it.
4. If you're unsure about something, explain your uncertainty and ask the user.
5. Keep changes minimal and focused. Don't refactor code you weren't asked to change.
6. If a command or operation fails, analyze the error and try a different approach. Don't repeat the same failing action.
7. Always verify your changes work (e.g., run tests, check for syntax errors).
```

#### 5. Environment Info

```
## Environment

- Working directory: ${workingDirectory}
- Platform: ${process.platform}
- Shell: ${process.env.SHELL ?? "sh"}
- Date: ${new Date().toISOString().split("T")[0]}
```

#### 6. User Instructions (Optional)

```
## User Instructions

${userInstructions}
```

### Model-Specific Prompt Adjustments

Different models may need different prompt styles:

```typescript
class PromptAdjuster {
  /**
   * Some models need more explicit tool-calling instructions.
   * Some models work better with XML-style tool definitions.
   * Some models need examples of tool usage.
   */
  adjust(prompt: string, modelFamily: string): string {
    switch (modelFamily) {
      case "llama":
        // Llama models generally follow the standard format well
        return prompt;
      case "mistral":
        // Mistral models sometimes need explicit JSON format reminders
        return prompt + "\n\nWhen calling tools, always use valid JSON for arguments.";
      case "codellama":
        // Code-focused models may benefit from more code examples
        return prompt;
      default:
        return prompt;
    }
  }
}
```

### Project Context File (CLAUDE.md / AGENT.md)

The agent should look for a project context file in the working directory:

```typescript
async function loadProjectContext(cwd: string): Promise<string | undefined> {
  const candidates = ["AGENT.md", "CLAUDE.md", ".agent.md", ".claude.md"];
  for (const name of candidates) {
    const filePath = path.join(cwd, name);
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
  }
  return undefined;
}
```

If found, its contents are appended to the system prompt as user instructions.

## File Locations

- `src/agent/system-prompt.ts` — Prompt builder
- `src/agent/prompt-templates.ts` — Template strings for each section

### Prompt Length Management

The system prompt must stay within a reasonable token budget to leave room for conversation:

- **Target**: Under 2000 tokens for the base prompt (without tool definitions).
- **Tool definitions**: Each tool adds ~100-200 tokens. With 8 tools: ~800-1600 additional tokens.
- **Total budget**: ~3000-4000 tokens for the complete system prompt.
- **Enforcement**: If the assembled prompt exceeds 5000 estimated tokens, log a warning. Tool descriptions are the first thing to shorten (use abbreviated versions).

```typescript
function enforcePromptBudget(prompt: string, maxTokens: number = 5000): string {
  const estimated = Math.ceil(prompt.length / 3.5);
  if (estimated > maxTokens) {
    logger.warn(`System prompt is ~${estimated} tokens (budget: ${maxTokens}). Consider shortening tool descriptions.`);
  }
  return prompt;
}
```

### Prompt Injection Mitigation

User-provided content embedded in the system prompt (project name, AGENT.md content, user instructions) could contain instructions that override the system prompt. Mitigations:

- Wrap user-provided content in clear delimiters: `--- BEGIN USER INSTRUCTIONS ---` / `--- END USER INSTRUCTIONS ---`.
- The core rules section (safety, tool usage) comes AFTER user instructions so it takes precedence.
- Log the full assembled prompt at TRACE level for debugging.

## Acceptance Criteria

1. System prompt is dynamically assembled based on available tools.
2. All tools are described with clear usage guidance.
3. Working directory and environment info are included.
4. Project context files (AGENT.md, etc.) are detected and included.
5. Safety rules are clear and comprehensive.
6. Prompt is not excessively long (aim for under 3000 tokens to leave room for conversation).
7. Unit tests verify prompt assembly with different configurations.

## Dependencies

- T-001, T-006 (Tool definitions)

## Blocks

- T-015 (Conversation Manager stores the system prompt)
- T-017 (Agent Loop initializes with the system prompt)
