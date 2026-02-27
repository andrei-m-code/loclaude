# T-010: File Delete Tool

## Status: Pending

## Priority: Medium

## Summary

Implement the `file_delete` tool that allows the agent to delete files and empty directories from the filesystem. This tool must be used carefully, so it includes safety checks and clear confirmation in its output.

## Detailed Implementation

### Tool Specification

| Property | Value |
|----------|-------|
| Name | `file_delete` |
| Description | "Delete a file or empty directory at the given absolute path." |

### Input Schema

```typescript
const inputSchema = z.object({
  file_path: z.string()
    .describe("The absolute path to the file or empty directory to delete"),
});
```

### Behavior

1. **Validate the path** — must be absolute.
2. **Check existence** — return error if path doesn't exist.
3. **Check type**:
   - If it's a file → delete with `fs.unlink`.
   - If it's a directory → check if empty. If empty, delete with `fs.rmdir`. If not empty, return error (we don't do recursive deletes for safety).
4. **Return confirmation** with what was deleted and its size.

### Safety Constraints

- **No recursive directory deletion** — `rm -rf` is too dangerous. The agent should use bash tool explicitly if it truly needs to delete a directory tree (and that has its own safety checks).
- **No glob/wildcard deletion** — only single paths.
- **Protected paths** — reject obvious system paths:
  - `/` (root)
  - `/etc`, `/usr`, `/bin`, `/sbin`, `/var`, `/sys`, `/proc`, `/dev`
  - Home directory itself (`~` or `$HOME`)
  - Anything outside the working directory tree (configurable)

### Output Format

```
Deleted file: /path/to/file.ts (1,234 bytes)
```

```
Deleted empty directory: /path/to/dir/
```

```
Error: Directory is not empty: /path/to/dir/ (contains 5 items). Use the bash tool with rm -rf if you really need to delete a non-empty directory.
```

### Implementation

```typescript
class FileDeleteTool extends BaseTool<FileDeleteInput> {
  readonly name = "file_delete";
  readonly description = "Delete a file or empty directory at the given absolute path.";

  readonly inputSchema = z.object({
    file_path: z.string().describe("The absolute path to the file or empty directory to delete"),
  });

  private protectedPaths = new Set(["/", "/etc", "/usr", "/bin", "/sbin", "/var", "/sys", "/proc", "/dev", "/tmp"]);

  async execute(input: FileDeleteInput): Promise<ToolResult> {
    const { file_path } = input;

    if (!path.isAbsolute(file_path)) {
      return { output: `Error: Path must be absolute. Got: ${file_path}` };
    }

    // Check protected paths
    const normalized = path.normalize(file_path);
    if (this.protectedPaths.has(normalized)) {
      return { output: `Error: Cannot delete protected system path: ${file_path}` };
    }

    // Check existence
    let stat: Stats;
    try {
      stat = await fs.stat(file_path);
    } catch (err) {
      if (err.code === "ENOENT") return { output: `Error: Path not found: ${file_path}` };
      if (err.code === "EACCES") return { output: `Error: Permission denied: ${file_path}` };
      throw err;
    }

    if (stat.isFile() || stat.isSymbolicLink()) {
      const size = stat.size;
      await fs.unlink(file_path);
      return { output: `Deleted file: ${file_path} (${formatBytes(size)})` };
    }

    if (stat.isDirectory()) {
      const entries = await fs.readdir(file_path);
      if (entries.length > 0) {
        return {
          output: `Error: Directory is not empty: ${file_path} (contains ${entries.length} items). Use the bash tool with rm -rf if you really need to delete a non-empty directory.`,
        };
      }
      await fs.rmdir(file_path);
      return { output: `Deleted empty directory: ${file_path}` };
    }

    return { output: `Error: Unsupported file type at: ${file_path}` };
  }
}
```

## File Location

- `src/tools/file-delete.ts`

## Acceptance Criteria

1. Deletes files correctly.
2. Deletes empty directories correctly.
3. Refuses to delete non-empty directories.
4. Refuses to delete protected system paths.
5. Returns informative messages for all outcomes.
6. Unit tests with temp files and directories.

## Dependencies

- T-001, T-006

## Blocks

- None directly.
