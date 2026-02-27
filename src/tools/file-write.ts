import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { BaseTool, type ToolResult } from "./types.js";
import { validateWorkspacePath } from "./workspace-scope.js";

const MAX_SIZE = 1024 * 1024; // 1MB

const inputSchema = z.object({
  file_path: z.string().describe("Absolute path to the file to write"),
  content: z.string().describe("Full content to write to the file"),
});

type FileWriteInput = z.infer<typeof inputSchema>;

export class FileWriteTool extends BaseTool<FileWriteInput> {
  readonly name = "file_write";
  readonly description =
    "Create or overwrite a file with the given content. The file_path must be an absolute path within the workspace. Parent directories are created automatically.";
  readonly inputSchema = inputSchema;

  private workspaceRoot: string;

  constructor(workspaceRoot?: string) {
    super();
    this.workspaceRoot = workspaceRoot ?? process.cwd();
  }

  async execute(input: FileWriteInput): Promise<ToolResult> {
    const filePath = path.resolve(input.file_path);

    // Validate absolute path
    if (!path.isAbsolute(input.file_path)) {
      return { output: `Error: file_path must be an absolute path, got: ${input.file_path}` };
    }

    // Workspace scope check
    const scopeError = validateWorkspacePath(filePath, this.workspaceRoot);
    if (scopeError) return { output: scopeError };

    // Size limit
    const byteSize = Buffer.byteLength(input.content, "utf-8");
    if (byteSize > MAX_SIZE) {
      return { output: `Error: Content exceeds maximum size (${byteSize} bytes > ${MAX_SIZE} bytes)` };
    }

    // Warn on binary content (null bytes)
    if (input.content.includes("\0")) {
      return { output: "Error: Content contains null bytes — file_write only handles text content" };
    }

    // Check if file already exists
    let existed = false;
    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        return { output: `Error: Path is a directory: ${filePath}` };
      }
      existed = true;
    } catch {
      // File doesn't exist — that's fine
    }

    // Auto-create parent directories
    const dir = path.dirname(filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Error creating parent directories: ${msg}` };
    }

    // Atomic write: write to temp file, then rename
    const tmpPath = path.join(dir, `.tmp_${crypto.randomBytes(8).toString("hex")}`);
    try {
      await fs.writeFile(tmpPath, input.content, "utf-8");
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      // Clean up temp file on failure
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EACCES")) {
        return { output: `Error: Permission denied: ${filePath}` };
      }
      if (msg.includes("ENOSPC")) {
        return { output: `Error: Disk full — could not write: ${filePath}` };
      }
      return { output: `Error writing file: ${msg}` };
    }

    const lines = input.content.split("\n").length;
    const action = existed ? "Updated" : "Created";
    return {
      output: `${action} ${filePath} (${byteSize} bytes, ${lines} lines)`,
      metadata: { filePath, byteSize, lines, existed },
    };
  }
}
