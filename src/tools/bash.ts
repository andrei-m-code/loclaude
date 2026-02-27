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

export class BashTool extends BaseTool<BashInput> {
  readonly name = "bash";
  readonly description =
    "Execute a shell command and return its output. Use this for running programs, installing packages, searching code, and any system operations.";
  readonly inputSchema = inputSchema;

  private activeProcesses: Set<ChildProcess> = new Set();

  async execute(input: BashInput): Promise<ToolResult> {
    const timeout = input.timeout ?? DEFAULT_TIMEOUT;
    const shell = process.env.SHELL || "/bin/sh";

    return new Promise<ToolResult>((resolve) => {
      let output = "";
      let truncated = false;
      let timedOut = false;

      const proc = spawn(shell, ["-c", input.command], {
        cwd: input.working_directory,
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

        let result = `$ ${input.command}\n\n${output}`;
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
