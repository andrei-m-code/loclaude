import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { BaseTool, type ToolResult } from "./types.js";
import { validateWorkspacePath, resolveWorkspacePath } from "./workspace-scope.js";

const PROTECTED_PATHS = new Set([
  "/",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/var",
  "/sys",
  "/proc",
  "/dev",
  "/tmp",
  "/boot",
  "/lib",
  "/opt",
  os.homedir(),
]);

const inputSchema = z.object({
  file_path: z.string().describe("Path to the file or empty directory to delete (absolute or relative to workspace)"),
});

type FileDeleteInput = z.infer<typeof inputSchema>;

export class FileDeleteTool extends BaseTool<FileDeleteInput> {
  readonly name = "file_delete";
  readonly description =
    "Delete a file or empty directory. Cannot delete non-empty directories (use bash with rm -rf for that). Paths can be absolute or relative to the workspace.";
  readonly inputSchema = inputSchema;

  private workspaceRoot: string;

  constructor(workspaceRoot?: string) {
    super();
    this.workspaceRoot = workspaceRoot ?? process.cwd();
  }

  async execute(input: FileDeleteInput): Promise<ToolResult> {
    const filePath = resolveWorkspacePath(input.file_path, this.workspaceRoot);

    // Workspace scope check
    const scopeError = validateWorkspacePath(input.file_path, this.workspaceRoot);
    if (scopeError) return { output: scopeError };

    // Protected path check
    if (PROTECTED_PATHS.has(filePath)) {
      return { output: `Error: Cannot delete protected path: ${filePath}` };
    }

    // Check existence
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(filePath);
    } catch {
      return { output: `Error: Path not found: ${filePath}` };
    }

    if (stat.isDirectory()) {
      // Only delete empty directories
      try {
        const entries = await fs.readdir(filePath);
        if (entries.length > 0) {
          return {
            output: `Error: Directory is not empty (${entries.length} items): ${filePath}\nUse the bash tool with 'rm -rf' if you need to delete a non-empty directory.`,
          };
        }
        await fs.rmdir(filePath);
        return { output: `Deleted empty directory: ${filePath}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Error deleting directory: ${msg}` };
      }
    }

    // Delete file (or symlink)
    const size = stat.size;
    const isSymlink = stat.isSymbolicLink();
    try {
      await fs.unlink(filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EACCES")) {
        return { output: `Error: Permission denied: ${filePath}` };
      }
      return { output: `Error deleting file: ${msg}` };
    }

    if (isSymlink) {
      return { output: `Deleted symlink: ${filePath}` };
    }
    return {
      output: `Deleted ${filePath} (${size} bytes)`,
      metadata: { filePath, size },
    };
  }
}
