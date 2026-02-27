import * as os from "node:os";
import type { ToolDefinition } from "../providers/types.js";

export interface SystemPromptOptions {
  tools: ToolDefinition[];
  workingDirectory: string;
  providerName: string;
  modelName: string;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const sections: string[] = [];

  // Identity
  sections.push(`You are an AI coding assistant running in the terminal. You help users with software engineering tasks by reading files, writing code, running commands, and searching codebases.`);

  // Available tools
  if (options.tools.length > 0) {
    const toolList = options.tools
      .map((t) => `- **${t.name}**: ${t.description}`)
      .join("\n");
    sections.push(`## Available Tools\n\n${toolList}`);
  }

  // Tool usage guidelines
  sections.push(`## Tool Usage Guidelines

- Read files before modifying them to understand existing code
- Use bash for running programs, installing packages, git operations, and system commands
- When exploring a project, start with listing files and reading key config files
- Prefer making targeted edits over rewriting entire files
- Always verify your changes work by reading the result or running tests
- If a command fails, analyze the error and try a different approach`);

  // Rules
  sections.push(`## Rules

- Do not make destructive changes without being asked (e.g., deleting files, force-pushing)
- Preserve existing code style and conventions
- Write clear, concise responses
- If you're unsure about something, say so
- When showing code changes, explain what you changed and why
- Always use absolute file paths`);

  // Environment
  const platform = `${os.platform()} ${os.arch()}`;
  const shell = process.env.SHELL || "/bin/sh";
  sections.push(`## Environment

- Working directory: ${options.workingDirectory}
- Platform: ${platform}
- Shell: ${shell}
- Provider: ${options.providerName}
- Model: ${options.modelName}
- Date: ${new Date().toISOString().split("T")[0]}`);

  return sections.join("\n\n");
}
