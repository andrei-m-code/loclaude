# T-008: File Write Tool

## Status: Pending

## Priority: High

## Summary

Implement the `file_write` tool that allows the agent to create new files or completely overwrite existing files. This tool is for writing entire file contents — for partial edits, the `file_edit` tool (T-009) should be used instead.

## Detailed Implementation

### Tool Specification

| Property | Value |
|----------|-------|
| Name | `file_write` |
| Description | "Write content to a file at the given absolute path. Creates the file if it doesn't exist, and creates any necessary parent directories. Overwrites the file if it already exists." |

### Input Schema

```typescript
const inputSchema = z.object({
  file_path: z.string()
    .describe("The absolute path to the file to write"),
  content: z.string()
    .describe("The full content to write to the file"),
});
```

### Behavior

1. **Validate the path** — must be absolute.
2. **Create parent directories** — use `fs.mkdir` with `{ recursive: true }` so the agent doesn't have to manually create directories.
3. **Write the file** — using `fs.writeFile` with UTF-8 encoding.
4. **Report result** — return a confirmation message including bytes written and whether the file was created or overwritten.

### Output Format

For a new file:
```
Created file: /path/to/file.ts (245 bytes, 12 lines)
```

For an existing file:
```
Overwrote file: /path/to/file.ts (245 bytes, 12 lines)
```

### Safety Considerations

- **Path validation**: Reject paths that contain `..` traversal or are clearly dangerous (e.g., `/etc/passwd`, `/dev/*`). Use a configurable allowlist of directories or a working directory constraint.
- **No binary content**: Only handle text content. If the content contains null bytes, warn.
- **Backup**: Optionally (configurable), create a `.bak` copy before overwriting.
- **Size limit**: Reject writes larger than a configurable limit (default: 1MB) to prevent accidental huge file creation.

### Edge Cases

- **Parent directory doesn't exist**: Auto-create with `recursive: true`.
- **Permission denied**: Return error message.
- **Path is a directory**: Return error message.
- **Disk full**: Catch and return error message.
- **Empty content**: Allow it — creating an empty file is valid.

### Implementation

```typescript
class FileWriteTool extends BaseTool<FileWriteInput> {
  readonly name = "file_write";
  readonly description = "Write content to a file. Creates the file and parent directories if they don't exist. Overwrites existing files.";

  readonly inputSchema = z.object({
    file_path: z.string().describe("The absolute path to the file to write"),
    content: z.string().describe("The full content to write to the file"),
  });

  async execute(input: FileWriteInput): Promise<ToolResult> {
    const { file_path, content } = input;

    if (!path.isAbsolute(file_path)) {
      return { output: `Error: Path must be absolute. Got: ${file_path}` };
    }

    // Check size limit
    const MAX_SIZE = 1024 * 1024; // 1MB
    if (Buffer.byteLength(content, "utf-8") > MAX_SIZE) {
      return { output: `Error: Content exceeds maximum size of 1MB` };
    }

    // Check if file already exists
    let existed = false;
    try {
      const stat = await fs.stat(file_path);
      if (stat.isDirectory()) {
        return { output: `Error: Path is a directory: ${file_path}` };
      }
      existed = true;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(file_path), { recursive: true });

    // Write file
    await fs.writeFile(file_path, content, "utf-8");

    const lineCount = content.split("\n").length;
    const byteCount = Buffer.byteLength(content, "utf-8");
    const action = existed ? "Overwrote" : "Created";

    return {
      output: `${action} file: ${file_path} (${byteCount} bytes, ${lineCount} lines)`,
      metadata: { existed, byteCount, lineCount },
    };
  }
}
```

## File Location

- `src/tools/file-write.ts`

### Atomic Writes

To prevent partial writes from corrupting files, use a write-then-rename strategy:

1. Write content to a temporary file in the same directory (e.g., `target.tmp.XXXX`).
2. If write succeeds, rename the temp file to the target path (atomic on POSIX).
3. If write fails, delete the temp file.

This ensures the target file is never in a half-written state.

### Path Traversal Protection

Validate that the resolved file path does not escape the expected scope:
- Resolve the path with `path.resolve()`.
- Reject paths containing `..` that resolve outside the working directory (when permissions require it).
- Reject paths to sensitive locations (`/etc/passwd`, `~/.ssh/`, etc.).

## Acceptance Criteria

1. Creates new files with correct content.
2. Overwrites existing files.
3. Auto-creates parent directories.
4. Returns informative success messages.
5. Handles all edge cases (permissions, directories, size limits).
6. Unit tests with temp directory.

## Dependencies

- T-001, T-006

## Blocks

- None directly, but agent functionality depends on this.
