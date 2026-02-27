import { AgentError } from "./base.js";

export class ToolError extends AgentError {
  readonly toolName: string;

  constructor(toolName: string, message: string, code: string, cause?: Error) {
    super({ message, code, retryable: false, cause, context: { toolName } });
    this.name = "ToolError";
    this.toolName = toolName;
  }
}

export class ToolInputValidationError extends ToolError {
  constructor(toolName: string, details: string) {
    super(toolName, `Invalid input for tool "${toolName}": ${details}`, "TOOL_INVALID_INPUT");
    this.name = "ToolInputValidationError";
  }
}

export class ToolExecutionError extends ToolError {
  constructor(toolName: string, cause: Error) {
    super(toolName, `Tool "${toolName}" failed: ${cause.message}`, "TOOL_EXECUTION_FAILED", cause);
    this.name = "ToolExecutionError";
  }
}

export class ToolNotFoundError extends ToolError {
  readonly availableTools: string[];

  constructor(toolName: string, availableTools: string[]) {
    super(
      toolName,
      `Tool "${toolName}" not found. Available tools: ${availableTools.join(", ")}`,
      "TOOL_NOT_FOUND",
    );
    this.name = "ToolNotFoundError";
    this.availableTools = availableTools;
  }
}
