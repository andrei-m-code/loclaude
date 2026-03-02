import * as path from "node:path";
import { z } from "zod";
import { spawn, type ChildProcess } from "node:child_process";
import { BaseTool, type ToolResult } from "./types.js";

const MAX_OUTPUT = 100 * 1024; // 100KB
const DEFAULT_TIMEOUT = 120_000; // 2 minutes
const MAX_TIMEOUT = 600_000; // 10 minutes
const KILL_DELAY = 5_000; // 5s between SIGTERM and SIGKILL

const inputSchema = z.object({
  command: z.string().describe("The shell command to execute"),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(MAX_TIMEOUT)
    .optional()
    .describe("Timeout in milliseconds (default: 120000, max: 600000)"),
  working_directory: z
    .string()
    .optional()
    .describe("Working directory for the command"),
});

type BashInput = z.infer<typeof inputSchema>;

// -- Command Safety Validation --

/**
 * Patterns that are always rejected — no legitimate use in a coding agent.
 * Each entry: [pattern, human-readable reason].
 */
const BLOCKED_PATTERNS: Array<[RegExp, string]> = [
  // sudo — never needed for project-scoped work
  [/(?:^|[;&|]\s*)sudo\b/, "sudo is not allowed — all operations must run without elevated privileges"],

  // Dangerous system commands
  [/(?:^|[;&|]\s*)mount\b/, "mount is not allowed — do not modify filesystem mounts"],
  [/(?:^|[;&|]\s*)umount\b/, "umount is not allowed — do not modify filesystem mounts"],
  [/(?:^|[;&|]\s*)mkfs\b/, "mkfs is not allowed — do not format filesystems"],
  [/(?:^|[;&|]\s*)fdisk\b/, "fdisk is not allowed — do not modify disk partitions"],
  [/(?:^|[;&|]\s*)(?:reboot|shutdown|poweroff|halt)\b/, "system power commands are not allowed"],
  [/(?:^|[;&|]\s*)(?:systemctl|launchctl)\b/, "system service commands are not allowed"],
  [/(?:^|[;&|]\s*)passwd\b/, "passwd is not allowed — do not modify user accounts"],
  [/(?:^|[;&|]\s*)chown\b/, "chown is not allowed — do not change file ownership"],
  [/(?:^|[;&|]\s*)dd\b/, "dd is not allowed — too dangerous for a coding agent"],

  // Download-to-execute patterns
  [/curl\b[^|]*\|\s*(?:ba)?sh/, "piping curl to shell is not allowed — download and review scripts before executing"],
  [/wget\b[^|]*\|\s*(?:ba)?sh/, "piping wget to shell is not allowed — download and review scripts before executing"],

  // Global package installs
  [/npm\s+(?:install|i)\s+(?:.*\s)?-g\b/, "global npm installs are not allowed — use local project installs"],
  [/npm\s+(?:install|i)\s+-[a-zA-Z]*g/, "global npm installs are not allowed — use local project installs"],
  [/pip\s+install\s+(?:.*\s)?--user\b/, "global pip installs are not allowed — use a virtual environment"],

  // rm -rf on root or common system dirs
  [/rm\s+(?:.*\s)?-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(?:\s|$)/, "rm -rf / is not allowed"],
  [/rm\s+(?:.*\s)?-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\/(?:\s|$)/, "rm -rf / is not allowed"],
];

/**
 * Safe absolute paths that are OK to reference (read-only or standard).
 */
const SAFE_ABSOLUTE_PREFIXES = [
  "/dev/null",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/zero",
  "/dev/urandom",
  "/dev/random",
  "/tmp/",
  "/var/folders/", // macOS temp dirs
  "/usr/bin/",
  "/usr/local/bin/",
  "/bin/",
  "/opt/homebrew/",
];

/**
 * Extract absolute paths from a command string.
 * Matches paths like /foo, /foo/bar, /foo/bar.txt but not flags like -f or
 * the /g in sed substitution patterns.
 */
function extractAbsolutePaths(command: string): string[] {
  // Match absolute paths: / followed by word chars, dots, hyphens, slashes
  // Negative lookbehind for = (env vars like PATH=/usr/bin) and ' " (quoted safe paths)
  const matches = command.match(/(?<!\w[=])(?:^|\s)(\/[\w./-]+)/g);
  if (!matches) return [];
  return matches.map((m) => m.trim());
}

/**
 * Check if an absolute path is safe (well-known system location or within workspace).
 */
function isPathSafe(absPath: string, workspaceRoot: string): boolean {
  // Within workspace is always fine
  const resolved = path.resolve(absPath);
  if (resolved.startsWith(workspaceRoot + "/") || resolved === workspaceRoot) {
    return true;
  }

  // Well-known safe paths
  for (const prefix of SAFE_ABSOLUTE_PREFIXES) {
    if (absPath.startsWith(prefix) || absPath === prefix.replace(/\/$/, "")) {
      return true;
    }
  }

  return false;
}

/**
 * Rewrite absolute paths that aren't within the workspace or known safe locations
 * to be relative paths (strip the leading /). Small models often output "/subdir"
 * when they mean "subdir" relative to the workspace.
 */
export function fixAbsolutePaths(command: string, workspaceRoot: string): string {
  const writeCommands = /\b(?:mkdir|touch|cp|mv|rm|rmdir|ln|cat\s*>|tee|install)\b/;
  if (!writeCommands.test(command)) return command;

  const absPaths = extractAbsolutePaths(command);
  let fixed = command;
  for (const p of absPaths) {
    if (!isPathSafe(p, workspaceRoot)) {
      // Strip leading / to make it relative to workspace
      const relative = p.replace(/^\//, "");
      fixed = fixed.replace(p, relative);
    }
  }
  return fixed;
}

/**
 * Validate a command before execution. Returns null if safe, or an error message if blocked.
 */
export function validateCommand(command: string, workspaceRoot: string): string | null {
  // Check blocked patterns
  for (const [pattern, reason] of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `BLOCKED: ${reason}.\nCommand: ${command}`;
    }
  }

  return null;
}

// -- Bash Tool --

export class BashTool extends BaseTool<BashInput> {
  readonly name = "bash";
  readonly description =
    "Execute a shell command. Use for: running builds/tests, installing packages, git operations, and system commands. Do NOT use bash for tasks that have a dedicated tool — use file_read (not cat), file_write (not echo >), file_edit (not sed), glob (not find), grep (not grep/rg), file_delete (not rm for single files). Common patterns: `rm -rf dir/` to remove non-empty directories, `mkdir -p a/b/c` to create nested dirs, `cp -r src/ dest/` to copy recursively.";
  readonly inputSchema = inputSchema;

  private workspaceRoot: string;
  private currentDir: string;
  private activeProcesses: Set<ChildProcess> = new Set();

  constructor(workspaceRoot?: string) {
    super();
    this.workspaceRoot = workspaceRoot ?? process.cwd();
    this.currentDir = this.workspaceRoot;
  }

  getCurrentDir(): string {
    return this.currentDir;
  }

  setCurrentDir(dir: string): void {
    this.currentDir = dir;
  }

  async execute(input: BashInput): Promise<ToolResult> {
    // Fix absolute paths that should be relative to workspace
    const command = fixAbsolutePaths(input.command, this.workspaceRoot);

    // Pre-validate the command before execution
    const violation = validateCommand(command, this.workspaceRoot);
    if (violation) {
      return { output: violation };
    }

    const timeout = input.timeout ?? DEFAULT_TIMEOUT;
    const shell = process.env.SHELL || "/bin/sh";
    const cwd = input.working_directory ?? this.currentDir;

    return new Promise<ToolResult>((resolve) => {
      let output = "";
      let truncated = false;
      let timedOut = false;

      const proc = spawn(shell, ["-c", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          TERM: "dumb",
          NO_COLOR: "1",
          CI: "true",
        },
      });

      this.activeProcesses.add(proc);

      const appendOutput = (data: Buffer) => {
        if (truncated) return;
        const text = data.toString();
        if (output.length + text.length > MAX_OUTPUT) {
          output += text.slice(0, MAX_OUTPUT - output.length);
          truncated = true;
        } else {
          output += text;
        }
      };

      proc.stdout?.on("data", appendOutput);
      proc.stderr?.on("data", appendOutput);

      // Timeout handling
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, KILL_DELAY);
      }, timeout);

      proc.on("close", (exitCode) => {
        clearTimeout(timer);
        this.activeProcesses.delete(proc);

        let result = `$ ${command}\n\n${output}`;
        if (truncated) {
          result += "\n... (output truncated)";
        }
        if (timedOut) {
          result += `\n\n[Timed out after ${timeout}ms]`;
        }
        result += `\n\n[Exit code: ${exitCode ?? 1}]`;

        resolve({ output: result });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        this.activeProcesses.delete(proc);
        resolve({ output: `Error executing command: ${err.message}` });
      });
    });
  }

  cleanup(): void {
    for (const proc of this.activeProcesses) {
      proc.kill("SIGTERM");
    }
    this.activeProcesses.clear();
  }

}
