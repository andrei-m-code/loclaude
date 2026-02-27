import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BaseTool, type ToolResult } from "./types.js";
import { validateWorkspacePath, resolveWorkspacePath } from "./workspace-scope.js";

const MAX_LINES = 2000;

const inputSchema = z.object({
  file_path: z.string().describe("Path to the file to read (absolute or relative to workspace)"),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based line number to start reading from"),
  limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
});

type FileReadInput = z.infer<typeof inputSchema>;

export class FileReadTool extends BaseTool<FileReadInput> {
  readonly name = "file_read";
  readonly description =
    "Read a file from the filesystem. Returns the file contents with line numbers. Paths can be absolute or relative to the workspace.";
  readonly inputSchema = inputSchema;

  private workspaceRoot: string;

  constructor(workspaceRoot?: string) {
    super();
    this.workspaceRoot = workspaceRoot ?? process.cwd();
  }

  async execute(input: FileReadInput): Promise<ToolResult> {
    const filePath = resolveWorkspacePath(input.file_path, this.workspaceRoot);

    // Workspace scope check
    const scopeError = validateWorkspacePath(input.file_path, this.workspaceRoot);
    if (scopeError) return { output: scopeError };

    // Check existence
    try {
      await fs.access(filePath);
    } catch {
      return { output: `Error: File not found: ${filePath}` };
    }

    // Check it's a file
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return { output: `Error: Not a file: ${filePath}` };
    }

    // Read the file
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EACCES")) {
        return { output: `Error: Permission denied: ${filePath}` };
      }
      return { output: `Error reading file: ${msg}` };
    }

    // Check for binary (null bytes)
    if (content.includes("\0")) {
      return { output: `Error: File appears to be binary: ${filePath}` };
    }

    // Handle empty files
    if (content.length === 0) {
      return { output: `File is empty: ${filePath}` };
    }

    // Split into lines and apply offset/limit
    let lines = content.split("\n");
    // Remove trailing empty line from final newline
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    const totalLines = lines.length;
    const offset = (input.offset ?? 1) - 1; // convert to 0-based
    const limit = input.limit ?? MAX_LINES;

    lines = lines.slice(offset, offset + limit);

    const truncated = totalLines > offset + limit;

    // Format with line numbers (cat -n style)
    const formatted = lines
      .map((line, i) => {
        const lineNum = offset + i + 1;
        return `${String(lineNum).padStart(6)}\t${line}`;
      })
      .join("\n");

    let output = formatted;
    if (truncated) {
      output += `\n\n... (${totalLines - offset - limit} more lines not shown. Use offset/limit to read more.)`;
    }

    return {
      output,
      metadata: {
        filePath,
        totalLines,
        linesShown: lines.length,
        offset: offset + 1,
      },
    };
  }
}
