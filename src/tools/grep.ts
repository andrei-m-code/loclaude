import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import fg from "fast-glob";
import { BaseTool, type ToolResult } from "./types.js";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_MAX_RESULTS = 100;
const CONCURRENCY = 10;
const BINARY_CHECK_SIZE = 8192;

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/__pycache__/**",
  "**/.venv/**",
];

const inputSchema = z.object({
  pattern: z.string().describe("Regular expression pattern to search for"),
  path: z
    .string()
    .optional()
    .describe("File or directory to search in (defaults to working directory)"),
  glob: z
    .string()
    .optional()
    .describe("Glob filter for files (e.g., '*.ts', '**/*.tsx')"),
  output_mode: z
    .enum(["files_with_matches", "content", "count"])
    .optional()
    .describe("Output mode: file paths only (default), matching lines with context, or match counts"),
  context_lines: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe("Lines of context around matches, only for 'content' mode (default: 0)"),
  case_insensitive: z.boolean().optional().describe("Case-insensitive matching (default: false)"),
  max_results: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Maximum number of results to return (default: ${DEFAULT_MAX_RESULTS})`),
});

type GrepInput = z.infer<typeof inputSchema>;

interface FileMatch {
  filePath: string;
  matches: Array<{ lineNum: number; line: string }>;
  matchCount: number;
}

/**
 * Check if a buffer contains null bytes (binary indicator).
 */
function isBinary(buffer: Buffer): boolean {
  const checkLen = Math.min(buffer.length, BINARY_CHECK_SIZE);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Search a single file for pattern matches.
 */
async function searchFile(
  filePath: string,
  regex: RegExp,
  contextLines: number,
  maxResults: number,
  currentCount: number,
): Promise<FileMatch | null> {
  // Check size
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null;

  // Read file
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch {
    return null;
  }

  // Skip binary
  if (isBinary(buffer)) return null;

  const content = buffer.toString("utf-8");
  const lines = content.split("\n");
  const matchingLines: Array<{ lineNum: number; line: string }> = [];
  let matchCount = 0;

  for (let i = 0; i < lines.length; i++) {
    // Reset lastIndex for stateful regexes
    regex.lastIndex = 0;
    if (regex.test(lines[i])) {
      matchCount++;
      if (currentCount + matchingLines.length < maxResults) {
        matchingLines.push({ lineNum: i + 1, line: lines[i] });
      }
    }
  }

  if (matchCount === 0) return null;

  // If context lines requested, expand to include surrounding lines
  if (contextLines > 0 && matchingLines.length > 0) {
    const expanded: Array<{ lineNum: number; line: string }> = [];
    const includedLines = new Set<number>();

    for (const m of matchingLines) {
      const start = Math.max(0, m.lineNum - 1 - contextLines);
      const end = Math.min(lines.length - 1, m.lineNum - 1 + contextLines);
      for (let i = start; i <= end; i++) {
        if (!includedLines.has(i)) {
          includedLines.add(i);
          expanded.push({ lineNum: i + 1, line: lines[i] });
        }
      }
    }
    expanded.sort((a, b) => a.lineNum - b.lineNum);
    return { filePath, matches: expanded, matchCount };
  }

  return { filePath, matches: matchingLines, matchCount };
}

export class GrepTool extends BaseTool<GrepInput> {
  readonly name = "grep";
  readonly description =
    "Search file contents using regex patterns. Returns matching files, lines with context, or match counts. Skips binary files and common directories (node_modules, .git, etc.).";
  readonly inputSchema = inputSchema;

  async execute(input: GrepInput): Promise<ToolResult> {
    // Validate regex
    let flags = "g";
    if (input.case_insensitive) flags += "i";
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, flags);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Error: Invalid regex pattern: ${msg}` };
    }

    const searchPath = input.path ? path.resolve(input.path) : process.cwd();
    const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;

    // Determine if searching a single file or a directory
    let filePaths: string[];
    try {
      const stat = await fs.stat(searchPath);
      if (stat.isFile()) {
        filePaths = [searchPath];
      } else if (stat.isDirectory()) {
        const globPattern = input.glob || "**/*";
        filePaths = await fg(globPattern, {
          cwd: searchPath,
          absolute: true,
          dot: true,
          ignore: DEFAULT_IGNORE,
          followSymbolicLinks: true,
          onlyFiles: true,
          suppressErrors: true,
        });
      } else {
        return { output: `Error: Not a file or directory: ${searchPath}` };
      }
    } catch {
      return { output: `Error: Path not found: ${searchPath}` };
    }

    if (filePaths.length === 0) {
      return { output: `No files to search in ${searchPath}` };
    }

    // Search files with concurrency limit
    const results: FileMatch[] = [];
    let totalMatches = 0;

    for (let i = 0; i < filePaths.length; i += CONCURRENCY) {
      if (totalMatches >= maxResults) break;

      const batch = filePaths.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((fp) => searchFile(fp, regex, input.context_lines ?? 0, maxResults, totalMatches)),
      );

      for (const result of batchResults) {
        if (result) {
          results.push(result);
          totalMatches += result.matchCount;
          if (totalMatches >= maxResults) break;
        }
      }
    }

    if (results.length === 0) {
      return { output: `No matches found for pattern "${input.pattern}" in ${searchPath}` };
    }

    // Format output based on mode
    const mode = input.output_mode ?? "files_with_matches";
    let output: string;

    switch (mode) {
      case "files_with_matches": {
        const lines = results.map((r) => r.filePath);
        output = lines.join("\n");
        output += `\n\n(${results.length} file${results.length === 1 ? "" : "s"} matched)`;
        break;
      }

      case "count": {
        const lines = results.map((r) => `${r.filePath}: ${r.matchCount}`);
        output = lines.join("\n");
        output += `\n\n(${totalMatches} total match${totalMatches === 1 ? "" : "es"} across ${results.length} file${results.length === 1 ? "" : "s"})`;
        break;
      }

      case "content": {
        const sections: string[] = [];
        for (const result of results) {
          const header = `${result.filePath}:`;
          const matchLines = result.matches.map(
            (m) => `  ${String(m.lineNum).padStart(5)}:  ${m.line}`,
          );
          sections.push(header + "\n" + matchLines.join("\n"));
        }
        output = sections.join("\n\n");
        if (totalMatches >= maxResults) {
          output += `\n\n(results capped at ${maxResults} — use a more specific pattern or path to narrow results)`;
        }
        break;
      }
    }

    return {
      output,
      metadata: { totalMatches, filesMatched: results.length, pattern: input.pattern },
    };
  }
}
