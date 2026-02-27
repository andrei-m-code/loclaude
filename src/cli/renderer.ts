import chalk from "chalk";
import type { TerminalUI } from "./terminal-ui.js";
import type { PlanStep } from "../agent/agent.js";

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
    this.ui.writeLine(line);
  }

  renderToolResult(_toolName: string, result: string, isError: boolean): void {
    const truncated = result.length > 200 ? result.slice(0, 200) + "..." : result;
    if (isError) {
      this.ui.writeLine(chalk.red(`  ✗ `) + chalk.dim(truncated));
    } else {
      this.ui.writeLine(chalk.green(`  ✓ `) + chalk.dim(truncated));
    }
  }

  renderPlan(steps: PlanStep[]): void {
    this.ui.writeLine(chalk.dim("  Plan:"));
    for (const step of steps) {
      const toolLabel = step.tool !== "none" ? chalk.cyan(` [${step.tool}]`) : "";
      this.ui.writeLine(chalk.dim(`  ${step.number}. ${step.description}`) + toolLabel);
    }
    this.ui.writeLine("");
  }

  renderStepStart(stepNumber: number, totalSteps: number, description: string): void {
    this.ui.writeLine(chalk.bold(`Step ${stepNumber}/${totalSteps}: ${description}`));
  }

  renderStepEnd(stepNumber: number, success: boolean): void {
    const icon = success ? chalk.green("✓") : chalk.red("✗");
    this.ui.writeLine(chalk.dim(`  ${icon} Step ${stepNumber} done`));
  }

  renderError(error: Error): void {
    this.ui.writeLine(chalk.red(`Error: ${error.message}`));
  }

  renderWarning(message: string): void {
    this.ui.writeLine(chalk.yellow(`Warning: ${message}`));
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
