# T-009: File Edit Tool

## Status: Pending

## Priority: High

## Summary

Implement the `file_edit` tool that allows the agent to make targeted edits to existing files using exact string replacement. This is the primary tool for modifying code — it's safer than full file rewrites because it only changes what's needed, reducing the risk of accidentally deleting or corrupting surrounding code.

## Context

Full file rewrites (file_write) are dangerous for edits because the LLM must reproduce the entire file, and any omission means lost code. String replacement edits solve this:
1. The agent provides an `old_string` that must be found in the file.
2. The agent provides a `new_string` to replace it with.
3. The tool verifies the old_string exists exactly once (to prevent ambiguous edits), then performs the replacement.

This is the same approach used by Claude Code's Edit tool and is proven to work well with LLMs.

## Detailed Implementation

### Tool Specification

| Property | Value |
|----------|-------|
| Name | `file_edit` |
| Description | "Make a targeted edit to a file by replacing an exact string match. The old_string must appear exactly once in the file (unless replace_all is true). This is the preferred way to modify existing files — use file_write only for creating new files." |

### Input Schema

```typescript
const inputSchema = z.object({
  file_path: z.string()
    .describe("The absolute path to the file to edit"),
  old_string: z.string()
    .describe("The exact string to find in the file. Must match exactly, including whitespace and indentation."),
  new_string: z.string()
    .describe("The replacement string. Must be different from old_string."),
  replace_all: z.boolean().optional().default(false)
    .describe("If true, replace ALL occurrences of old_string. Default is false (replace first unique match only)."),
});
```

### Behavior

1. **Validate inputs**:
   - Path must be absolute.
   - `old_string` and `new_string` must be different.
   - `old_string` cannot be empty.
2. **Read the file** — must exist.
3. **Find the old_string** in the file content:
   - If `replace_all` is false: must appear exactly once. If it appears 0 times → error. If it appears 2+ times → error with count and suggestion to provide more context.
   - If `replace_all` is true: must appear at least once.
4. **Perform the replacement**.
5. **Write the file back**.
6. **Return a diff-like summary** of what changed.

### Output Format

Success:
```
Edited file: /path/to/file.ts
Replaced 1 occurrence.

--- before
+++ after
@@ -10,3 +10,3 @@
   const x = 1;
-  const y = 2;
+  const y = 42;
   const z = 3;
```

Ambiguous match:
```
Error: old_string appears 3 times in /path/to/file.ts. Provide more surrounding context to make the match unique, or use replace_all: true to replace all occurrences.
```

Not found:
```
Error: old_string not found in /path/to/file.ts. Make sure the string matches exactly, including whitespace and indentation.
```

### Diff Generation

Generate a simple unified diff showing context around the change:

```typescript
function generateDiff(
  oldContent: string,
  newContent: string,
  contextLines: number = 3
): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // Find the first and last differing lines
  // Show `contextLines` lines of context before and after
  // Format as unified diff with --- / +++ / @@ headers

  // Use a simple line-by-line diff algorithm
  // (No need for a full Myers diff — we know exactly what changed)
}
```

Since we know the exact replacement, we can compute the diff more efficiently:
1. Find the line range of the old_string in the original file.
2. Find the line range of the new_string in the new file.
3. Show context lines around the changed region.

### Edge Cases

- **File not found**: Error message.
- **old_string not found**: Error with helpful message.
- **Multiple matches** (when replace_all is false): Error with count.
- **old_string equals new_string**: Error — no-op edit.
- **Empty new_string**: Allowed — effectively deletes the old_string.
- **Whitespace sensitivity**: The match is exact, including whitespace. This is intentional — the LLM must match indentation precisely.
- **Very large old_string**: Allowed but may be slow. No hard limit.
- **Result is identical to original** (edge case with replace_all where all replacements result in same content): Warn.

### Implementation

```typescript
class FileEditTool extends BaseTool<FileEditInput> {
  readonly name = "file_edit";
  readonly description = "Make a targeted edit to a file by replacing an exact string match. The old_string must appear exactly once in the file unless replace_all is true.";

  readonly inputSchema = z.object({
    file_path: z.string().describe("The absolute path to the file to edit"),
    old_string: z.string().min(1).describe("The exact string to find and replace"),
    new_string: z.string().describe("The replacement string"),
    replace_all: z.boolean().optional().default(false).describe("Replace all occurrences"),
  });

  async execute(input: FileEditInput): Promise<ToolResult> {
    const { file_path, old_string, new_string, replace_all } = input;

    if (!path.isAbsolute(file_path)) {
      return { output: `Error: Path must be absolute. Got: ${file_path}` };
    }

    if (old_string === new_string) {
      return { output: `Error: old_string and new_string are identical. No edit needed.` };
    }

    // Read file
    let content: string;
    try {
      content = await fs.readFile(file_path, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") return { output: `Error: File not found: ${file_path}` };
      if (err.code === "EACCES") return { output: `Error: Permission denied: ${file_path}` };
      throw err;
    }

    // Count occurrences
    const occurrences = countOccurrences(content, old_string);

    if (occurrences === 0) {
      return {
        output: `Error: old_string not found in ${file_path}. Make sure the string matches exactly, including whitespace and indentation.`,
      };
    }

    if (!replace_all && occurrences > 1) {
      return {
        output: `Error: old_string appears ${occurrences} times in ${file_path}. Provide more surrounding context to make the match unique, or set replace_all: true.`,
      };
    }

    // Perform replacement
    let newContent: string;
    if (replace_all) {
      newContent = content.split(old_string).join(new_string);
    } else {
      const index = content.indexOf(old_string);
      newContent = content.slice(0, index) + new_string + content.slice(index + old_string.length);
    }

    // Write back
    await fs.writeFile(file_path, newContent, "utf-8");

    // Generate diff
    const diff = generateSimpleDiff(content, newContent);
    const replacedCount = replace_all ? occurrences : 1;

    return {
      output: `Edited file: ${file_path}\nReplaced ${replacedCount} occurrence${replacedCount > 1 ? "s" : ""}.\n\n${diff}`,
    };
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}
```

## File Location

- `src/tools/file-edit.ts`

### Atomic Edit Safety

File edits use the same atomic write strategy as file_write (T-008):
1. Read the current file content.
2. Apply the string replacement in memory.
3. Write the modified content to a temp file in the same directory.
4. Rename the temp file to the original path.

This ensures the file is never in a partially-written state.

### Line Ending Preservation

The edit tool must preserve the file's existing line ending style:
- If the file uses `\r\n` (CRLF), keep CRLF after edits.
- If the file uses `\n` (LF), keep LF.
- Detect by checking the first line ending found in the file.
- The `old_string` match must account for the actual line endings present in the file.

## Acceptance Criteria

1. Single replacement works correctly.
2. `replace_all` mode works correctly.
3. Ambiguous match (multiple occurrences) returns clear error.
4. Not-found returns clear error.
5. Diff output is generated and readable.
6. Whitespace is preserved exactly.
7. Edge cases handled (empty new_string for deletion, permissions, etc.).
8. Unit tests cover all scenarios including edge cases.

## Dependencies

- T-001, T-006

## Blocks

- None directly.
