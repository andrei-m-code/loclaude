import * as path from "node:path";

/**
 * Resolve a file path relative to the workspace root.
 * Accepts both absolute and relative paths.
 */
export function resolveWorkspacePath(filePath: string, workspaceRoot: string): string {
  return path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceRoot, filePath);
}

/**
 * Validate that a file path is within the workspace root.
 * Returns null if valid, or an error message string if out of scope.
 */
export function validateWorkspacePath(filePath: string, workspaceRoot: string): string | null {
  const resolved = resolveWorkspacePath(filePath, workspaceRoot);
  const normalizedRoot = path.resolve(workspaceRoot);

  if (resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep)) {
    return null;
  }

  return `BLOCKED: Path "${resolved}" is outside the workspace (${normalizedRoot}). All file operations must target paths within the workspace directory.`;
}
