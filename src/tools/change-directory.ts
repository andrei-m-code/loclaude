import * as path from "node:path";
import * as fs from "node:fs/promises";
import { z } from "zod";
import { BaseTool, type ToolResult } from "./types.js";
import type { BashTool } from "./bash.js";

const inputSchema = z.object({
  path: z
    .string()
    .describe("Directory path to switch to (absolute or relative to current directory)"),
});

type ChangeDirectoryInput = z.infer<typeof inputSchema>;

export class ChangeDirectoryTool extends BaseTool<ChangeDirectoryInput> {
  readonly name = "change_directory";
  readonly description =
    "Change the working directory. All subsequent bash commands will run in the new directory. The path must be within the workspace.";
  readonly inputSchema = inputSchema;

  private bashTool: BashTool;
  private workspaceRoot: string;

  constructor(bashTool: BashTool, workspaceRoot: string) {
    super();
    this.bashTool = bashTool;
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  async execute(input: ChangeDirectoryInput): Promise<ToolResult> {
    // Resolve relative to current directory (not workspace root)
    const currentDir = this.bashTool.getCurrentDir();
    const resolved = path.resolve(currentDir, input.path);

    // Validate within workspace bounds
    if (resolved !== this.workspaceRoot && !resolved.startsWith(this.workspaceRoot + path.sep)) {
      return {
        output: `BLOCKED: Directory "${resolved}" is outside the workspace (${this.workspaceRoot}). You can only navigate within the workspace.`,
      };
    }

    // Check directory exists
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        return { output: `Error: Not a directory: ${resolved}` };
      }
    } catch {
      return { output: `Error: Directory not found: ${resolved}` };
    }

    // Update bash tool's working directory
    this.bashTool.setCurrentDir(resolved);

    const relative = path.relative(this.workspaceRoot, resolved) || ".";
    return {
      output: `Changed directory to ${resolved} (${relative})`,
      metadata: { newDir: resolved, relative },
    };
  }
}
