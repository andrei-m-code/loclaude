# T-011: Glob Tool (File Pattern Search)

## Status: Pending

## Priority: High

## Summary

Implement the `glob` tool that allows the agent to find files by name patterns. This is essential for navigating unfamiliar codebases — the agent needs to discover files matching patterns like `**/*.ts`, `src/components/**/*.tsx`, or `**/package.json`.

## Context

When working on code, the agent frequently needs to:
- Find all TypeScript files in a project: `**/*.ts`
- Locate a specific file by name: `**/config.ts`
- Find test files: `**/*.test.ts` or `**/*.spec.ts`
- List files in a directory: `src/components/*`

The glob tool provides this capability using standard glob patterns.

## Detailed Implementation

### Tool Specification

| Property | Value |
|----------|-------|
| Name | `glob` |
| Description | "Find files matching a glob pattern. Returns a list of matching file paths sorted by modification time (most recent first). Use this to discover files in the project." |

### Input Schema

```typescript
const inputSchema = z.object({
  pattern: z.string()
    .describe("Glob pattern to match files (e.g., '**/*.ts', 'src/**/*.tsx', '**/package.json')"),
  path: z.string().optional()
    .describe("Directory to search in. Defaults to the current working directory."),
});
```

### Behavior

1. **Resolve the search path** — use provided `path` or fall back to `process.cwd()`.
2. **Execute glob** — use a glob library (e.g., `fast-glob` or `glob` package).
3. **Apply default exclusions** — always exclude:
   - `node_modules/**`
   - `.git/**`
   - `dist/**`
   - `build/**`
   - `coverage/**`
   - `.next/**`
   - `__pycache__/**`
   - `.venv/**`
4. **Sort results** — by modification time (most recent first), so the most relevant files appear at the top.
5. **Limit results** — cap at 200 files. If more match, show the count and suggest a more specific pattern.
6. **Return formatted list** — one path per line.

### Output Format

```
Found 15 files matching "**/*.ts":

src/index.ts
src/agent/agent.ts
src/agent/conversation.ts
src/providers/types.ts
src/providers/ollama.ts
src/tools/types.ts
src/tools/registry.ts
src/tools/file-read.ts
src/tools/file-write.ts
src/tools/file-edit.ts
src/tools/file-delete.ts
src/tools/glob.ts
src/tools/grep.ts
src/tools/bash.ts
src/tools/http-request.ts
```

When truncated:
```
Found 1,234 files matching "**/*". Showing first 200.
Use a more specific pattern to narrow results.

file1.ts
file2.ts
...
```

No results:
```
No files found matching "**/*.xyz" in /path/to/project
```

### Implementation

```typescript
import fg from "fast-glob";

class GlobTool extends BaseTool<GlobInput> {
  readonly name = "glob";
  readonly description = "Find files matching a glob pattern. Returns matching file paths sorted by modification time.";

  readonly inputSchema = z.object({
    pattern: z.string().describe("Glob pattern (e.g., '**/*.ts')"),
    path: z.string().optional().describe("Directory to search in"),
  });

  private defaultIgnore = [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/.next/**",
    "**/__pycache__/**",
    "**/.venv/**",
    "**/.DS_Store",
  ];

  private maxResults = 200;

  async execute(input: GlobInput): Promise<ToolResult> {
    const searchPath = input.path ?? process.cwd();

    // Validate search path exists
    try {
      const stat = await fs.stat(searchPath);
      if (!stat.isDirectory()) {
        return { output: `Error: Not a directory: ${searchPath}` };
      }
    } catch {
      return { output: `Error: Directory not found: ${searchPath}` };
    }

    // Execute glob
    const entries = await fg(input.pattern, {
      cwd: searchPath,
      ignore: this.defaultIgnore,
      dot: false,              // Don't match dotfiles by default
      onlyFiles: true,
      stats: true,             // Include stat info for sorting
      absolute: false,         // Return relative paths
    });

    if (entries.length === 0) {
      return { output: `No files found matching "${input.pattern}" in ${searchPath}` };
    }

    // Sort by modification time (most recent first)
    entries.sort((a, b) => {
      const aTime = a.stats?.mtimeMs ?? 0;
      const bTime = b.stats?.mtimeMs ?? 0;
      return bTime - aTime;
    });

    // Limit results
    const totalCount = entries.length;
    const truncated = totalCount > this.maxResults;
    const shown = truncated ? entries.slice(0, this.maxResults) : entries;

    // Format output
    let output = "";
    if (truncated) {
      output += `Found ${totalCount} files matching "${input.pattern}". Showing first ${this.maxResults}.\nUse a more specific pattern to narrow results.\n\n`;
    } else {
      output += `Found ${totalCount} file${totalCount === 1 ? "" : "s"} matching "${input.pattern}":\n\n`;
    }

    output += shown.map(e => e.path ?? e.name).join("\n");

    return { output };
  }
}
```

### npm Dependency

- `fast-glob` — Fast and reliable glob implementation with stat support.

## File Location

- `src/tools/glob.ts`

### Symlink Handling

- Glob follows symlinks by default (consistent with file_read behavior).
- Symlink loop protection: if the same real path is encountered twice during traversal, skip the duplicate.
- Use `fast-glob`'s `followSymbolicLinks: true` option (default).

### Case Sensitivity

- On Linux: case-sensitive matching (default filesystem behavior).
- On macOS: case-insensitive matching (HFS+/APFS default).
- Use `fast-glob`'s `caseSensitiveMatch` option, defaulting to `process.platform !== "darwin"`.

### Scope Restriction

- By default, glob searches within the `path` parameter (or CWD if not specified).
- The `path` parameter must resolve to a directory within the project or CWD.
- Absolute paths outside the project are allowed but go through the permission system (T-021).

## Acceptance Criteria

1. Basic glob patterns work (`*.ts`, `**/*.ts`, `src/**/*`).
2. Default exclusions filter out node_modules, .git, etc.
3. Results sorted by modification time.
4. Result count limited to 200 with helpful message.
5. Search path parameter works correctly.
6. No matches returns a clear message.
7. Unit tests with a temp directory structure.

## Dependencies

- T-001, T-006

## Blocks

- None directly, but very useful for the agent to navigate codebases.
