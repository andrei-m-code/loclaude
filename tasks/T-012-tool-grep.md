# T-012: Grep Tool (Content Search)

## Status: Pending

## Priority: High

## Summary

Implement the `grep` tool that allows the agent to search for text patterns within file contents. This is essential for understanding codebases — finding where functions are defined, where variables are used, locating error messages, tracing imports, etc.

## Context

While `glob` finds files by name, `grep` finds files (and specific lines) by content. The agent needs both to effectively navigate and understand code. Example use cases:

- Find where a function is defined: `"function parseConfig"`
- Find all usages of an API: `"fetch\(.*\/api\/"`
- Find TODO comments: `"TODO|FIXME|HACK"`
- Trace an import: `"import.*from.*utils"`
- Find error messages: `"Error:.*connection"`

## Detailed Implementation

### Tool Specification

| Property | Value |
|----------|-------|
| Name | `grep` |
| Description | "Search for a text pattern in file contents using regular expressions. Returns matching file paths, or matching lines with context. Use this to find where code is defined, used, or referenced." |

### Input Schema

```typescript
const inputSchema = z.object({
  pattern: z.string()
    .describe("Regular expression pattern to search for (e.g., 'function\\s+parseConfig', 'TODO|FIXME')"),
  path: z.string().optional()
    .describe("File or directory to search in. Defaults to current working directory."),
  glob: z.string().optional()
    .describe("Glob pattern to filter which files to search (e.g., '*.ts', '*.{js,jsx}')"),
  output_mode: z.enum(["files_with_matches", "content", "count"]).optional().default("files_with_matches")
    .describe("Output mode: 'files_with_matches' (default) returns only file paths, 'content' shows matching lines with context, 'count' shows match counts per file"),
  context_lines: z.number().int().min(0).max(10).optional().default(0)
    .describe("Number of lines to show before and after each match (only for 'content' mode). Default: 0."),
  case_insensitive: z.boolean().optional().default(false)
    .describe("If true, search case-insensitively."),
  max_results: z.number().int().min(1).optional().default(100)
    .describe("Maximum number of results to return. Default: 100."),
});
```

### Output Modes

#### `files_with_matches` (default)

Just file paths — fast and compact:
```
Found 8 files matching "parseConfig":

src/config/config.ts
src/config/loader.ts
src/utils/parser.ts
tests/config/config.test.ts
tests/config/loader.test.ts
tests/utils/parser.test.ts
docs/configuration.md
README.md
```

#### `content`

Matching lines with context:
```
Found 5 matches across 3 files for "parseConfig":

src/config/config.ts:
  23:   const result = parseConfig(rawData);
  --
  45: export function parseConfig(data: unknown): Config {
  46:   const validated = schema.safeParse(data);
  47:   if (!validated.success) {

src/config/loader.ts:
  12: import { parseConfig } from "./config";
  --
  78:     return parseConfig(fileContents);
```

#### `count`

Match counts per file:
```
Match counts for "TODO":

src/agent/agent.ts: 3
src/tools/registry.ts: 2
src/providers/ollama.ts: 1
Total: 6 matches in 3 files
```

### Implementation Strategy

We have two options for the actual search:
1. **Pure Node.js** — recursively walk directories, read files, apply regex. Simple but slow on large codebases.
2. **Spawn `ripgrep` (rg)** — if available on the system, use it for speed. Fall back to Node.js if not available.

**Chosen approach**: Start with pure Node.js for portability. Optimize with ripgrep later if needed.

### Implementation

```typescript
class GrepTool extends BaseTool<GrepInput> {
  readonly name = "grep";
  readonly description = "Search for a text pattern in file contents using regular expressions.";

  readonly inputSchema = z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    path: z.string().optional().describe("File or directory to search in"),
    glob: z.string().optional().describe("Glob filter for files (e.g., '*.ts')"),
    output_mode: z.enum(["files_with_matches", "content", "count"]).optional().default("files_with_matches"),
    context_lines: z.number().int().min(0).max(10).optional().default(0),
    case_insensitive: z.boolean().optional().default(false),
    max_results: z.number().int().min(1).optional().default(100),
  });

  private defaultIgnore = [
    "node_modules", ".git", "dist", "build", "coverage",
    ".next", "__pycache__", ".venv",
  ];

  async execute(input: GrepInput): Promise<ToolResult> {
    const searchPath = input.path ?? process.cwd();
    const flags = input.case_insensitive ? "gi" : "g";
    let regex: RegExp;

    try {
      regex = new RegExp(input.pattern, flags);
    } catch (err) {
      return { output: `Error: Invalid regex pattern: ${err.message}` };
    }

    // Discover files to search
    const files = await this.discoverFiles(searchPath, input.glob);

    if (files.length === 0) {
      return { output: `No files to search in ${searchPath}` };
    }

    // Search files
    const results: SearchResult[] = [];
    let totalMatches = 0;

    for (const filePath of files) {
      if (totalMatches >= input.max_results) break;

      try {
        const content = await fs.readFile(filePath, "utf-8");

        // Skip binary files
        if (isBinary(content)) continue;

        const lines = content.split("\n");
        const fileMatches: LineMatch[] = [];

        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            fileMatches.push({ lineNumber: i + 1, content: lines[i] });
            totalMatches++;
            if (totalMatches >= input.max_results) break;
          }
          regex.lastIndex = 0; // Reset for global regex
        }

        if (fileMatches.length > 0) {
          results.push({
            filePath: path.relative(process.cwd(), filePath),
            matches: fileMatches,
            allLines: lines,
          });
        }
      } catch {
        // Skip files we can't read
        continue;
      }
    }

    if (results.length === 0) {
      return { output: `No matches found for "${input.pattern}" in ${searchPath}` };
    }

    // Format output based on mode
    return { output: this.formatOutput(results, input, totalMatches) };
  }

  private formatOutput(results: SearchResult[], input: GrepInput, totalMatches: number): string {
    switch (input.output_mode) {
      case "files_with_matches":
        return this.formatFilesOnly(results, input.pattern);
      case "content":
        return this.formatWithContent(results, input);
      case "count":
        return this.formatCounts(results, input.pattern, totalMatches);
      default:
        return this.formatFilesOnly(results, input.pattern);
    }
  }

  private formatFilesOnly(results: SearchResult[], pattern: string): string {
    let output = `Found ${results.length} file${results.length === 1 ? "" : "s"} matching "${pattern}":\n\n`;
    output += results.map(r => r.filePath).join("\n");
    return output;
  }

  private formatWithContent(results: SearchResult[], input: GrepInput): string {
    // Format each file's matches with optional context lines
    // Include line numbers and surrounding context
    // Separate matches within a file with "--" divider
    // ... (full implementation)
  }

  private formatCounts(results: SearchResult[], pattern: string, total: number): string {
    let output = `Match counts for "${pattern}":\n\n`;
    for (const r of results) {
      output += `${r.filePath}: ${r.matches.length}\n`;
    }
    output += `\nTotal: ${total} matches in ${results.length} files`;
    return output;
  }
}
```

### Performance Considerations

- **Skip binary files** — check for null bytes in the first 8KB.
- **Skip large files** — files over 5MB are probably not source code; skip with a warning.
- **Parallel file reading** — read multiple files concurrently (limit concurrency to ~10 to avoid fd exhaustion).
- **Early termination** — stop once max_results is reached.
- **Default ignore patterns** — skip node_modules, .git, etc.

## File Location

- `src/tools/grep.ts`

### Binary File Skipping

Skip binary files during search (same detection as T-007):
- Check the first 8KB for null bytes.
- If binary, skip the file silently (do not include in results).
- Log at TRACE level: "Skipping binary file: <path>".

### Multiline Matching

The `multiline` parameter (default: false) controls cross-line matching:
- When `false`: Pattern matches within single lines only (standard behavior).
- When `true`: The entire file content is treated as one string; `.` matches newlines, `^` and `$` match line boundaries.
- Implementation: Use the `s` (dotAll) and `m` (multiline) RegExp flags when `multiline: true`.

### Large File Handling

- Files larger than 5MB are skipped by default to prevent memory issues.
- This threshold is configurable via `tools.files.maxReadSize` in config.
- When a file is skipped, log at DEBUG level: "Skipping large file (X MB): <path>".

## Acceptance Criteria

1. Regex search works correctly across files.
2. All three output modes work (files_with_matches, content, count).
3. Context lines work correctly in content mode.
4. Case-insensitive search works.
5. Glob filtering works (e.g., only search `*.ts` files).
6. Binary files are skipped.
7. Default ignore patterns are applied.
8. Max results limit is enforced.
9. Invalid regex returns a clear error.
10. Unit tests with temp files containing known patterns.

## Dependencies

- T-001, T-006

## Blocks

- None directly, but critical for agent effectiveness.
