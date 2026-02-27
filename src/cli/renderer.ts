import chalk from "chalk";
import type { TerminalUI } from "./terminal-ui.js";
import type { ExecutionPlan, VerificationResult } from "../agent/planner.js";

export class Renderer {
  private ui: TerminalUI;

  constructor(ui: TerminalUI) {
    this.ui = ui;
  }

  renderToolCall(toolName: string, args: Record<string, unknown>): void {
    const summary = this.summarizeArgs(toolName, args);
    const icon = this.getToolIcon(toolName);
    let line = chalk.dim(`  ${icon} ${toolName}`);
    if (summary) {
      line += chalk.dim(` ${summary}`);
    }
    this.ui.writeLine(line);
  }

  renderToolResult(_toolName: string, result: string, isError: boolean): void {
    const truncated = result.length > 200 ? result.slice(0, 200) + "..." : result;
    if (isError) {
      this.ui.writeLine(chalk.red(`  ✗ ${truncated}`));
    } else {
      this.ui.writeLine(chalk.green("  ✓ ") + chalk.dim(truncated));
    }
  }

  renderError(error: Error): void {
    this.ui.writeLine(chalk.red(`Error: ${error.message}`));
  }

  renderWarning(message: string): void {
    this.ui.writeLine(chalk.yellow(`Warning: ${message}`));
  }

  // -- 3-Phase Rendering --

  renderPhaseStart(phase: "plan" | "execute" | "verify"): void {
    const labels: Record<string, string> = {
      plan: "Phase 1: Planning",
      execute: "Phase 2: Executing",
      verify: "Phase 3: Verifying",
    };
    const label = labels[phase] ?? phase;
    const line = chalk.blue(`--- ${label} ---`);
    this.ui.writeLine(line);
  }

  renderPhaseEnd(_phase: "plan" | "execute" | "verify"): void {
    // No-op — clean output
  }

  renderPlan(plan: ExecutionPlan): void {
    this.ui.writeLine(chalk.dim(`  Plan: ${plan.summary}`));
    for (const step of plan.steps) {
      const toolLabel = step.tool !== "none" ? chalk.cyan(` [${step.tool}]`) : "";
      this.ui.writeLine(chalk.dim(`  ${step.stepNumber}. ${step.description}`) + toolLabel);
    }
    this.ui.writeLine("");
  }

  renderStepStart(stepNumber: number, totalSteps: number, description: string): void {
    this.ui.writeLine(chalk.bold(`Step ${stepNumber}/${totalSteps}: ${description}`));
  }

  renderStepEnd(stepNumber: number, success: boolean): void {
    if (success) {
      this.ui.writeLine(chalk.green(`  ✓ Step ${stepNumber} complete`));
    } else {
      this.ui.writeLine(chalk.red(`  ✗ Step ${stepNumber} failed`));
    }
  }

  renderVerification(result: VerificationResult): void {
    const colorFn =
      result.status === "complete" ? chalk.green :
      result.status === "partial" ? chalk.yellow :
      chalk.red;

    this.ui.writeLine(colorFn(`  Status: ${result.status}`));
    if (result.summary) {
      this.ui.writeLine(chalk.dim(`  ${result.summary}`));
    }
    if (result.issues.length > 0) {
      for (const issue of result.issues) {
        this.ui.writeLine(chalk.yellow(`  - ${issue}`));
      }
    }
  }

  private getToolIcon(toolName: string): string {
    const icons: Record<string, string> = {
      file_read: "[R]",
      file_write: "[W]",
      file_edit: "[E]",
      file_delete: "[D]",
      glob: "[G]",
      grep: "[S]",
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
      default:
        return "";
    }
  }
}
