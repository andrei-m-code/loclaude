import chalk from "chalk";
import type { TerminalUI } from "./terminal-ui.js";
import type { PlanStep } from "../agent/agent.js";

const BOX_H = "─";

export class Renderer {
  private ui: TerminalUI;

  constructor(ui: TerminalUI) {
    this.ui = ui;
  }

  renderToolCall(toolName: string, args: Record<string, unknown>): void {
    const summary = this.summarizeArgs(toolName, args);
    const icon = this.getToolIcon(toolName);
    let line = chalk.cyan(`  ${icon}`) + chalk.white(` ${toolName}`);
    if (summary) {
      line += chalk.dim(` ${summary}`);
    }
    this.ui.writeLine(this.truncateLine(line));
  }

  renderToolResult(_toolName: string, result: string, isError: boolean): void {
    // Collapse to first line only and truncate for display
    const firstLine = result.split("\n")[0] ?? result;
    const truncated = firstLine.length > 200 ? firstLine.slice(0, 200) + "..." : firstLine;
    if (isError) {
      this.ui.writeLine(this.truncateLine(chalk.red(`  ✗ `) + chalk.dim(truncated)));
    } else {
      this.ui.writeLine(this.truncateLine(chalk.green(`  ✓ `) + chalk.dim(truncated)));
    }
  }

  renderPlan(steps: PlanStep[]): void {
    this.ui.writeLine("");
    const ruleWidth = Math.min(50, this.ui.getWidth() - 2);
    this.ui.writeLine(chalk.dim(`  ${BOX_H.repeat(ruleWidth)}`));
    this.ui.writeLine(chalk.bold("  Plan"));
    this.ui.writeLine("");
    for (const step of steps) {
      const num = chalk.bold.cyan(`  ${step.number}.`);
      const desc = step.description;
      const toolLabel = step.tool !== "none" ? chalk.dim(` [${step.tool}]`) : "";
      this.ui.writeLine(this.truncateLine(`${num} ${desc}${toolLabel}`));
    }
    this.ui.writeLine(chalk.dim(`  ${BOX_H.repeat(ruleWidth)}`));
    this.ui.writeLine("");
  }

  renderStepStart(stepNumber: number, totalSteps: number, description: string): void {
    this.ui.writeLine("");
    const badge = chalk.bgCyan.black.bold(` ${stepNumber}/${totalSteps} `);
    this.ui.writeLine(this.truncateLine(`${badge} ${chalk.bold(description)}`));
  }

  renderStepEnd(_stepNumber: number, success: boolean): void {
    const icon = success ? chalk.green("  ✓ done") : chalk.red("  ✗ failed");
    this.ui.writeLine(chalk.dim(icon));
  }

  renderError(error: Error): void {
    this.ui.writeLine(chalk.red(`Error: ${error.message}`));
  }

  renderWarning(message: string): void {
    this.ui.writeLine(chalk.yellow(`Warning: ${message}`));
  }

  /**
   * Truncate a line to terminal width. Strips ANSI codes for length calculation,
   * but preserves them in output. Appends "…" if truncated.
   */
  private truncateLine(line: string): string {
    const width = this.ui.getWidth();
    if (width <= 0) return line;

    // Strip ANSI escape codes for visible length calculation
    // eslint-disable-next-line no-control-regex
    const visibleLength = line.replace(/\x1b\[[0-9;]*m/g, "").length;
    if (visibleLength <= width) return line;

    // Truncate by walking through chars, counting visible length
    let visible = 0;
    let i = 0;
    while (i < line.length && visible < width - 1) {
      if (line[i] === "\x1b") {
        // Skip ANSI sequence
        const end = line.indexOf("m", i);
        if (end !== -1) {
          i = end + 1;
          continue;
        }
      }
      visible++;
      i++;
    }
    return line.slice(0, i) + "…" + "\x1b[0m"; // reset after truncation
  }

  private getToolIcon(toolName: string): string {
    const icons: Record<string, string> = {
      file_read: "[R]",
      file_write: "[W]",
      file_edit: "[E]",
      file_delete: "[D]",
      glob: "[G]",
      grep: "[S]",
      list_directory: "[L]",
      bash: "[$]",
      http_request: "[H]",
    };
    return icons[toolName] ?? "[?]";
  }

  private summarizeArgs(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case "file_read":
        return String(args.file_path ?? "");
      case "file_write":
        return String(args.file_path ?? "");
      case "file_edit":
        return String(args.file_path ?? "");
      case "file_delete":
        return String(args.file_path ?? "");
      case "bash": {
        const cmd = String(args.command ?? "");
        return cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
      }
      case "glob":
        return String(args.pattern ?? "");
      case "grep":
        return String(args.pattern ?? "");
      case "list_directory":
        return String(args.path ?? ".");
      case "http_request": {
        const method = String(args.method ?? "GET").toUpperCase();
        const url = String(args.url ?? "");
        return `${method} ${url.length > 60 ? url.slice(0, 60) + "..." : url}`;
      }
      default:
        return "";
    }
  }
}
