import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BaseTool, type ToolResult } from "./types.js";

const IGNORE = new Set([
  "node_modules", ".git", "dist", "build", "coverage",
  ".next", "__pycache__", ".venv", "venv",
  ".cache", ".parcel-cache", ".turbo",
  ".DS_Store", "Thumbs.db",
]);

const inputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Absolute path to the directory to list (defaults to working directory)"),
  recursive: z
    .boolean()
    .optional()
    .describe("List subdirectories recursively up to 3 levels deep (default: false)"),
});

type ListDirectoryInput = z.infer<typeof inputSchema>;

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}M`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)}K`;
  return `${bytes}B`;
}

async function listDir(
  dir: string,
  prefix: string,
  depth: number,
  maxDepth: number,
): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf-8" }) as import("node:fs").Dirent[];
  } catch {
    return [prefix + "(permission denied)"];
  }

  // Filter ignored entries
  const filtered = entries.filter((e) => !IGNORE.has(e.name));

  // Sort: directories first, then files, alphabetically within each group
  filtered.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i];
    const fullPath = path.join(dir, entry.name);
    const isLast = i === filtered.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";

    if (entry.isDirectory()) {
      lines.push(prefix + connector + entry.name + "/");
      if (depth < maxDepth) {
        const children = await listDir(fullPath, prefix + childPrefix, depth + 1, maxDepth);
        lines.push(...children);
      }
    } else {
      let sizeStr = "";
      try {
        const stat = await fs.stat(fullPath);
        sizeStr = `  (${formatSize(stat.size)})`;
      } catch { /* skip size */ }
      lines.push(prefix + connector + entry.name + sizeStr);
    }
  }

  return lines;
}

export class ListDirectoryTool extends BaseTool<ListDirectoryInput> {
  readonly name = "list_directory";
  readonly description =
    "List files and directories in a given path. Shows a tree view with file sizes. Use this to understand project structure before reading or modifying files.";
  readonly inputSchema = inputSchema;

  async execute(input: ListDirectoryInput): Promise<ToolResult> {
    const targetDir = input.path ? path.resolve(input.path) : process.cwd();

    // Validate directory exists
    try {
      const stat = await fs.stat(targetDir);
      if (!stat.isDirectory()) {
        return { output: `Error: Not a directory: ${targetDir}` };
      }
    } catch {
      return { output: `Error: Directory not found: ${targetDir}` };
    }

    const maxDepth = input.recursive ? 3 : 1;
    const lines = await listDir(targetDir, "", 0, maxDepth);

    if (lines.length === 0) {
      return { output: `Directory is empty: ${targetDir}` };
    }

    const header = path.basename(targetDir) + "/";
    const output = header + "\n" + lines.join("\n");

    return {
      output,
      metadata: { path: targetDir, entries: lines.length },
    };
  }
}
