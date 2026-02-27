import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import fg from "fast-glob";
import { BaseTool, type ToolResult } from "./types.js";

const MAX_RESULTS = 200;

const DEFAULT_IGNORE = [
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

const inputSchema = z.object({
  pattern: z.string().describe("Glob pattern (e.g., '**/*.ts', 'src/**/*.test.js')"),
  path: z
    .string()
    .optional()
    .describe("Directory to search in (defaults to working directory)"),
});

type GlobInput = z.infer<typeof inputSchema>;

export class GlobTool extends BaseTool<GlobInput> {
  readonly name = "glob";
  readonly description =
    "Find files matching a glob pattern. Returns file paths sorted by modification time (most recent first). Common directories like node_modules and .git are excluded by default.";
  readonly inputSchema = inputSchema;

  async execute(input: GlobInput): Promise<ToolResult> {
    const searchDir = input.path ? path.resolve(input.path) : process.cwd();

    // Validate search directory exists
    try {
      const stat = await fs.stat(searchDir);
      if (!stat.isDirectory()) {
        return { output: `Error: Not a directory: ${searchDir}` };
      }
    } catch {
      return { output: `Error: Directory not found: ${searchDir}` };
    }

    let entries: string[];
    try {
      entries = await fg(input.pattern, {
        cwd: searchDir,
        absolute: true,
        dot: true,
        ignore: DEFAULT_IGNORE,
        followSymbolicLinks: true,
        onlyFiles: true,
        suppressErrors: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Error: Invalid glob pattern: ${msg}` };
    }

    if (entries.length === 0) {
      return { output: `No files matched pattern "${input.pattern}" in ${searchDir}` };
    }

    // Sort by mtime (most recent first), with dedup for symlink loops
    const seen = new Set<string>();
    const withStats: Array<{ filePath: string; mtime: number }> = [];

    for (const filePath of entries) {
      try {
        const realPath = await fs.realpath(filePath);
        if (seen.has(realPath)) continue;
        seen.add(realPath);

        const stat = await fs.stat(filePath);
        withStats.push({ filePath, mtime: stat.mtimeMs });
      } catch {
        // Skip files we can't stat (broken symlinks, permission issues)
      }
    }

    withStats.sort((a, b) => b.mtime - a.mtime);

    const total = withStats.length;
    const limited = withStats.slice(0, MAX_RESULTS);

    const lines = limited.map((e) => e.filePath);

    let output = lines.join("\n");
    if (total > MAX_RESULTS) {
      output += `\n\n(${total} total matches, showing first ${MAX_RESULTS} — use a more specific pattern to narrow results)`;
    } else {
      output += `\n\n(${total} file${total === 1 ? "" : "s"} matched)`;
    }

    return {
      output,
      metadata: { totalMatches: total, shown: limited.length, pattern: input.pattern },
    };
  }
}
