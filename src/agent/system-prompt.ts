import * as os from "node:os";
import type { ToolDefinition } from "../providers/types.js";

export interface SystemPromptOptions {
  tools: ToolDefinition[];
  workingDirectory: string;
  providerName: string;
  modelName: string;
  workspaceContext?: string;
}

export interface PlanningPromptOptions {
  tools: ToolDefinition[];
  workingDirectory: string;
  workspaceContext?: string;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const sections: string[] = [];
  const cwd = options.workingDirectory;

  // -- Identity + Workspace --
  sections.push(`You are loclaude, an AI coding agent in the user's terminal. You read/write files, edit code, run commands, and search code. Every action has real consequences.

## Workspace
Your workspace is: ${cwd}
ALL file and command operations MUST stay within this directory and its subdirectories. You have full access to create/edit/delete files in any subfolder. Never access paths outside it. Never use sudo.

When tackling a task: first investigate (read files, list directories) before making changes. Explain your approach briefly, then execute.`);

  // -- Rules --
  sections.push(`## Rules
- Read files before editing. Make the minimum change needed.
- Preserve existing code style. Don't refactor or "improve" unrequested code.
- Use list_directory before creating/modifying files to understand existing structure.
- Never run destructive commands unless explicitly asked.
- Never fabricate file contents or tool output. If unsure, ask.
- Be concise. Show what changed, not entire files.
- **NEVER use \`cd\` to change directories.** All tools work from the workspace root. Use relative paths like \`subdir/file.txt\` for file tools, and \`working_directory\` parameter or full paths for bash commands.`);

  // -- Tool Reference (compact) --
  sections.push(buildToolReference(options.tools));

  // -- Tool Usage Guidelines (trimmed) --
  sections.push(buildToolUsageGuidelines(options));

  // -- Environment --
  const platform = `${os.platform()} ${os.arch()}`;
  const shell = process.env.SHELL || "/bin/sh";
  sections.push(`## Environment
- Working directory: ${cwd}
- Platform: ${platform}
- Shell: ${shell}
- Provider: ${options.providerName}
- Model: ${options.modelName}
- Date: ${new Date().toISOString().split("T")[0]}`);

  // -- Workspace Context --
  if (options.workspaceContext) {
    sections.push(`## Workspace Context
${options.workspaceContext}`);
  }

  return sections.join("\n\n");
}

/**
 * Compact tool reference — one-line-per-param format instead of JSON blobs.
 */
function buildToolReference(tools: ToolDefinition[]): string {
  if (tools.length === 0) {
    return "## Tools\n\nNo tools available. Respond with text only.";
  }

  let section = `## Tools: ${tools.map((t) => t.name).join(", ")}\n`;

  for (const tool of tools) {
    section += `\n### ${tool.name}\n${tool.description}\n`;
    const params = tool.parameters as {
      type: string;
      properties?: Record<string, { type?: string; description?: string; enum?: string[] }>;
      required?: string[];
    };
    if (params.properties) {
      const required = new Set(params.required ?? []);
      for (const [name, prop] of Object.entries(params.properties)) {
        const req = required.has(name) ? ", required" : "";
        const enumStr = prop.enum ? `, enum: ${prop.enum.join("|")}` : "";
        section += `- ${name} (${prop.type ?? "string"}${req}${enumStr}) — ${prop.description ?? ""}\n`;
      }
    }
  }

  return section;
}

/**
 * Trimmed tool usage guidelines — no per-tool workspace path repetitions.
 */
function buildToolUsageGuidelines(options: SystemPromptOptions): string {
  const toolNames = new Set(options.tools.map((t) => t.name));
  const cwd = options.workingDirectory;

  const lines: string[] = ["## Tool Tips"];

  // -- Use the right tool (not bash) --
  lines.push(`
### Use the Right Tool
Do NOT use bash when a dedicated tool exists:
- Read files → **file_read** (not \`cat\` or \`head\`)
- Write/create files → **file_write** (not \`echo >\` or \`cat >\`)
- Edit files → **file_edit** (not \`sed\` or \`awk\`)
- Delete a single file → **file_delete** (not \`rm\`)
- Find files by name → **glob** (not \`find\`)
- Search file contents → **grep** (not \`grep\` or \`rg\` via bash)
- List directory → **list_directory** (not \`ls\`)

Use bash ONLY for: builds, tests, git, package installs, running programs, and commands with no dedicated tool.`);

  if (toolNames.has("file_read")) {
    lines.push("- **file_read**: Always read a file before modifying it. Use offset/limit for large files.");
  }

  if (toolNames.has("file_edit")) {
    lines.push("- **file_edit**: Prefer over file_write for targeted changes. old_string must match exactly.");
  }

  if (toolNames.has("file_write")) {
    lines.push("- **file_write**: Read existing file first before overwriting. Creates parent directories automatically.");
  }

  if (toolNames.has("file_delete")) {
    lines.push("- **file_delete**: Deletes a single file or empty directory. For non-empty directories, use bash: `rm -rf dir/`");
  }

  if (toolNames.has("bash")) {
    lines.push(`
### Bash Usage
- All commands run from \`${cwd}\` by default. Use \`working_directory\` parameter for subdirectories — do NOT use \`cd\`.
- **NEVER run applications** to verify changes. Commands like \`dotnet run\`, \`node app.js\`, \`python main.py\`, \`./app\`, \`npm start\`, \`cargo run\` can block forever. Use build commands instead (\`dotnet build\`, \`npm run build\`, \`go build\`, etc.).
- No sudo, no interactive commands (vi, nano, less), no global installs.
- Common patterns:
  - Remove non-empty directory: \`rm -rf dirname/\` (NOT \`rmdir\` — that only works on empty dirs)
  - Create nested directories: \`mkdir -p a/b/c\`
  - Copy recursively: \`cp -r src/ dest/\`
  - Move/rename: \`mv old new\`
  - Run in background: append \`&\`
  - Chain commands: \`cmd1 && cmd2\` (stop on failure) or \`cmd1; cmd2\` (always continue)
  - Redirect output: \`cmd > file.txt 2>&1\`

### When a Command Fails
Do NOT retry the same command. Instead:
- Read the error message carefully
- If "not found" or "No such file" → use glob or list_directory to find the correct path
- If "Permission denied" → check if the file exists and you have the right path
- If missing flags → check the command's correct usage (e.g., \`rm -rf\` not \`rm\`, \`mkdir -p\` not \`mkdir\`)
- If a tool fails → try a different tool or approach entirely`);
  }

  if (toolNames.has("list_directory")) {
    lines.push("- **list_directory**: Use before creating/editing files to see what exists.");
  }

  if (toolNames.has("glob")) {
    lines.push("- **glob**: Use to find files by pattern (e.g., `**/*.ts`).");
  }

  if (toolNames.has("grep")) {
    lines.push("- **grep**: Use to search file contents with regex.");
  }

  // Fallback for when file_write/file_edit are not available but bash is
  if (!toolNames.has("file_write") && !toolNames.has("file_edit") && toolNames.has("bash")) {
    lines.push("");
    lines.push("**No file_write/file_edit tools.** Use bash with heredoc (`cat > file << 'EOF'`) or sed for edits.");
  }

  return lines.join("\n");
}

/**
 * Build the planning-phase system prompt (fallback models only).
 * Used for the initial tool-free call where the model either answers directly
 * or produces a numbered plan.
 */
export function buildPlanningPrompt(options: PlanningPromptOptions): string {
  const toolList = options.tools.map(t => `- ${t.name}: ${t.description}`).join("\n");

  const sections: string[] = [];

  sections.push(`You are loclaude, an AI coding agent in the user's terminal. You help with software engineering tasks by reading/writing files, editing code, running commands, and searching codebases.

## Workspace
${options.workingDirectory}`);

  if (options.workspaceContext) {
    sections.push(`## Project Structure
${options.workspaceContext}`);
  }

  sections.push(`## Available Tools
${toolList}

## Your Job Right Now
The user will give you a task. You have two options:

**Option A — Simple question/greeting**: Just answer directly. No plan needed.

**Option B — Task requiring tools** (file operations, commands, code changes): Output a brief numbered plan. Do NOT execute anything yet — just plan.

Plan format:
1. Step description [tool_name]
2. Step description [tool_name]
...

Keep it under 10 steps. Be specific with file paths and search patterns.

## Guidelines
- ALWAYS search first: use glob/grep to find files before editing
- Read files before editing — understand existing code first
- Use the right tool for the job
- **NEVER run applications** (\`dotnet run\`, \`node app.js\`, etc.) — they can block forever. Build commands are fine.
- **NEVER use \`cd\`** — use relative paths from workspace root.`);

  return sections.join("\n\n");
}

