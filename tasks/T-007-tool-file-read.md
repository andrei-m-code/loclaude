# T-007: File Read Tool

## Status: Pending

## Priority: High

## Summary

Implement the `file_read` tool that allows the agent to read file contents from the local filesystem. This is the most fundamental tool — the agent must be able to read files to understand code before modifying it.

## Detailed Implementation

### Tool Specification

| Property | Value |
|----------|-------|
| Name | `file_read` |
| Description | "Read the contents of a file at the given absolute path. Returns the file contents with line numbers. Supports text files, and can optionally read a specific range of lines." |

### Input Schema

```typescript
const inputSchema = z.object({
  file_path: z.string()
    .describe("The absolute path to the file to read"),
  offset: z.number().int().min(1).optional()
    .describe("Line number to start reading from (1-based). Defaults to 1."),
  limit: z.number().int().min(1).optional()
    .describe("Maximum number of lines to read. Defaults to reading the entire file."),
});
```

### Behavior

1. **Validate the path** — must be an absolute path (starts with `/` on Unix, drive letter on Windows).
2. **Check file exists** — if not, return an error message (not throw).
3. **Check it's a file** — not a directory, symlink to directory, etc.
4. **Read the file** — using `fs.readFile` with UTF-8 encoding.
5. **Apply offset/limit** — if specified, slice the lines.
6. **Format output** — prepend line numbers (matching `cat -n` style).
7. **Handle large files** — if file exceeds 2000 lines and no limit specified, truncate and add a note.

### Output Format

```
     1	import { readFile } from "fs/promises";
     2	import { join } from "path";
     3
     4	export function hello() {
     5	  console.log("hello world");
     6	}
```

Line numbers are right-aligned with padding. A tab separates the line number from the content. This format makes it easy for the LLM to reference specific lines.

### Edge Cases

- **File not found**: Return `"Error: File not found: /path/to/file"` (as output, not exception).
- **Permission denied**: Return `"Error: Permission denied: /path/to/file"`.
- **Binary file**: Detect binary content (check for null bytes in first 8KB). Return `"Error: File appears to be binary: /path/to/file"`.
- **Empty file**: Return `"File is empty: /path/to/file"`.
- **Very large file (>2000 lines)**: Read up to 2000 lines, append `"\n... (file truncated, showing first 2000 of N total lines. Use offset/limit to read more.)"`.
- **Long lines (>2000 chars)**: Truncate individual lines and add `... (truncated)`.
- **Encoding issues**: Handle non-UTF-8 gracefully (try UTF-8, fall back to latin1, note in output).

### Implementation

```typescript
class FileReadTool extends BaseTool<FileReadInput> {
  readonly name = "file_read";
  readonly description = "Read the contents of a file at the given absolute path. Returns the file contents with line numbers.";
  readonly inputSchema = z.object({
    file_path: z.string().describe("The absolute path to the file to read"),
    offset: z.number().int().min(1).optional().describe("Line number to start reading from (1-based)"),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
  });

  async execute(input: FileReadInput): Promise<ToolResult> {
    const { file_path, offset, limit } = input;

    // Validate absolute path
    if (!path.isAbsolute(file_path)) {
      return { output: `Error: Path must be absolute. Got: ${file_path}` };
    }

    // Check existence and type
    try {
      const stat = await fs.stat(file_path);
      if (!stat.isFile()) {
        return { output: `Error: Not a file: ${file_path}` };
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        return { output: `Error: File not found: ${file_path}` };
      }
      if (err.code === "EACCES") {
        return { output: `Error: Permission denied: ${file_path}` };
      }
      throw err;
    }

    // Read file
    const content = await fs.readFile(file_path, "utf-8");

    // Check for binary
    if (isBinary(content)) {
      return { output: `Error: File appears to be binary: ${file_path}` };
    }

    // Handle empty
    if (content.length === 0) {
      return { output: `File is empty: ${file_path}` };
    }

    // Split into lines and apply offset/limit
    let lines = content.split("\n");
    const totalLines = lines.length;

    const startLine = offset ?? 1;
    const endLine = limit ? startLine + limit - 1 : totalLines;

    lines = lines.slice(startLine - 1, endLine);

    // Truncate if too many lines
    const MAX_LINES = 2000;
    let truncated = false;
    if (lines.length > MAX_LINES) {
      lines = lines.slice(0, MAX_LINES);
      truncated = true;
    }

    // Format with line numbers
    const maxLineNumWidth = String(startLine + lines.length - 1).length;
    const formatted = lines.map((line, i) => {
      const lineNum = String(startLine + i).padStart(maxLineNumWidth);
      const truncatedLine = line.length > 2000 ? line.slice(0, 2000) + "... (truncated)" : line;
      return `${lineNum}\t${truncatedLine}`;
    }).join("\n");

    let output = formatted;
    if (truncated) {
      output += `\n\n... (file truncated, showing ${MAX_LINES} of ${totalLines} total lines. Use offset/limit to read more.)`;
    }

    return { output };
  }
}
```

## File Location

- `src/tools/file-read.ts`

### Binary File Detection

Detect binary files by checking for null bytes in the first 8KB:

```typescript
async function isBinaryFile(filePath: string): Promise<boolean> {
  const fd = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(buffer, 0, 8192, 0);
    // Check for null bytes (common in binary files, rare in text)
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } finally {
    await fd.close();
  }
}
```

Exception: UTF-16 and UTF-32 files contain null bytes but are text. If the file starts with a BOM (Byte Order Mark), treat it as text:
- UTF-16 LE: `0xFF 0xFE`
- UTF-16 BE: `0xFE 0xFF`
- UTF-32 LE: `0xFF 0xFE 0x00 0x00`

### Encoding Handling

Default to UTF-8. If decoding fails (replacement characters), attempt fallback:

```typescript
async function readFileWithEncoding(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);

  // Try UTF-8 first
  const utf8 = buffer.toString("utf-8");
  const hasReplacementChars = utf8.includes("\uFFFD");

  if (!hasReplacementChars) return utf8;

  // Fallback to latin1 (ISO-8859-1) — never fails, maps bytes 1:1
  return buffer.toString("latin1");
}
```

### Symlink Behavior

- Follow symlinks transparently (use `fs.readFile`, which follows by default).
- If the resolved path is outside the project directory, the permission system (T-021) handles access control.
- If a symlink is broken (target doesn't exist), return a clear error: "File not found (broken symlink)".

## Acceptance Criteria

1. Reads files successfully and returns line-numbered output.
2. Offset and limit parameters work correctly.
3. All edge cases handled (file not found, binary, empty, large, permissions).
4. Large files are truncated with a helpful message.
5. Unit tests cover all edge cases (use temp files in tests).

## Dependencies

- T-001 (project setup)
- T-006 (tool framework)

## Blocks

- T-017 (agent needs at least one real tool to test end-to-end)
