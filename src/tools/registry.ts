import type { Tool, ToolResult } from "./types.js";
import type { BaseTool } from "./types.js";
import type { ToolDefinition } from "../providers/types.js";
import { ToolNotFoundError } from "../errors/index.js";

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => (tool as BaseTool<unknown>).toDefinition());
  }

  async executeTool(name: string, rawInput: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolNotFoundError(name, this.getToolNames());
    }
    const validated = (tool as BaseTool<unknown>).validateInput(rawInput);
    return tool.execute(validated);
  }

  get size(): number {
    return this.tools.size;
  }
}
