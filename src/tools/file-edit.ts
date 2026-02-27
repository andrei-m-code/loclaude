import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { BaseTool, type ToolResult } from "./types.js";

const inputSchema = z.object({
  file_path: z.string().describe("Absolute path to the file to edit"),
  old_string: z.string().min(1).describe("Exact string to find in the file (case-sensitive, whitespace-sensitive)"),
  new_string: z.string().describe("Replacement string (must differ from old_string; empty string deletes the match)"),
  replace_all: z
    .boolean()
    .optional()
    .describe("Replace all occurrences (default: false — requires exactly 1 match)"),
});

type FileEditInput = z.infer<typeof inputSchema>;

/**
 * Detect the dominant line ending in a file.
 */
function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Generate a minimal unified diff snippet showing the edit context.
 */
function generateDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
  lineEnding: string,
): string {
  const oldLines = oldContent.split(lineEnding);
  const newLines = newContent.split(lineEnding);

  // Find first differing line
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }

  // Find last differing line (from the end)
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const contextBefore = Math.max(0, start - 2);
  const contextAfterOld = Math.min(oldLines.length - 1, oldEnd + 2);
  const contextAfterNew = Math.min(newLines.length - 1, newEnd + 2);

  const lines: string[] = [];
  lines.push(`--- ${filePath}`);
  lines.push(`+++ ${filePath}`);
  lines.push(`@@ -${contextBefore + 1},${contextAfterOld - contextBefore + 1} +${contextBefore + 1},${contextAfterNew - contextBefore + 1} @@`);

  // Context before
  for (let i = contextBefore; i < start; i++) {
    lines.push(` ${oldLines[i]}`);
  }
  // Removed lines
  for (let i = start; i <= oldEnd; i++) {
    lines.push(`-${oldLines[i]}`);
  }
  // Added lines
  for (let i = start; i <= newEnd; i++) {
    lines.push(`+${newLines[i]}`);
  }
  // Context after
  for (let i = oldEnd + 1; i <= contextAfterOld; i++) {
    lines.push(` ${oldLines[i]}`);
  }

  return lines.join("\n");
}

export class FileEditTool extends BaseTool<FileEditInput> {
  readonly name = "file_edit";
  readonly description =
    "Make targeted edits to a file using exact string replacement. Safer than rewriting entire files. The old_string must match exactly (including whitespace and indentation).";
  readonly inputSchema = inputSchema;

  async execute(input: FileEditInput): Promise<ToolResult> {
    const filePath = path.resolve(input.file_path);

    if (!path.isAbsolute(input.file_path)) {
      return { output: `Error: file_path must be an absolute path, got: ${input.file_path}` };
    }

    if (input.old_string === input.new_string) {
      return { output: "Error: old_string and new_string are identical — no edit to make" };
    }

    // Read the file
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOENT")) {
        return { output: `Error: File not found: ${filePath}` };
      }
      if (msg.includes("EACCES")) {
        return { output: `Error: Permission denied: ${filePath}` };
      }
      return { output: `Error reading file: ${msg}` };
    }

    // Count occurrences
    let count = 0;
    let searchPos = 0;
    while (true) {
      const idx = content.indexOf(input.old_string, searchPos);
      if (idx === -1) break;
      count++;
      searchPos = idx + input.old_string.length;
    }

    if (count === 0) {
      // Provide a helpful snippet of the file to aid debugging
      const preview = content.length > 200 ? content.slice(0, 200) + "..." : content;
      return {
        output: `Error: old_string not found in ${filePath}.\n\nSearched for:\n${input.old_string}\n\nFile starts with:\n${preview}`,
      };
    }

    if (!input.replace_all && count > 1) {
      return {
        output: `Error: old_string found ${count} times in ${filePath}. Set replace_all=true to replace all, or provide a longer/more specific old_string to match exactly once.`,
      };
    }

    // Detect line ending style to preserve it
    const lineEnding = detectLineEnding(content);

    // Perform replacement
    let newContent: string;
    if (input.replace_all) {
      newContent = content.split(input.old_string).join(input.new_string);
    } else {
      const idx = content.indexOf(input.old_string);
      newContent = content.slice(0, idx) + input.new_string + content.slice(idx + input.old_string.length);
    }

    // Atomic write
    const dir = path.dirname(filePath);
    const tmpPath = path.join(dir, `.tmp_${crypto.randomBytes(8).toString("hex")}`);
    try {
      await fs.writeFile(tmpPath, newContent, "utf-8");
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Error writing file: ${msg}` };
    }

    // Generate diff
    const diff = generateDiff(filePath, content, newContent, lineEnding);
    const replacements = input.replace_all ? `${count} replacement${count > 1 ? "s" : ""}` : "1 replacement";

    return {
      output: `Edited ${filePath} (${replacements})\n\n${diff}`,
      metadata: { filePath, replacements: count },
    };
  }
}
