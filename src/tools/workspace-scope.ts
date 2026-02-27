import * as path from "node:path";

/**
 * Validate that a file path is within the workspace root.
 * Returns null if valid, or an error message string if out of scope.
 */
export function validateWorkspacePath(filePath: string, workspaceRoot: string): string | null {
  const resolved = path.resolve(filePath);
  const normalizedRoot = path.resolve(workspaceRoot);

  if (resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep)) {
    return null;
  }

  return `BLOCKED: Path "${resolved}" is outside the workspace (${normalizedRoot}). All file operations must target paths within the workspace directory.`;
}
