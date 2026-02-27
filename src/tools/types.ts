import type { z } from "zod";
import type { ToolDefinition } from "../providers/types.js";
import { zodToJsonSchema } from "./schema.js";

export interface ToolResult {
  output: string;
  metadata?: Record<string, unknown>;
}

export interface Tool<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  execute(input: TInput): Promise<ToolResult>;
}

export abstract class BaseTool<TInput> implements Tool<TInput> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly inputSchema: z.ZodType<TInput>;

  abstract execute(input: TInput): Promise<ToolResult>;

  validateInput(raw: unknown): TInput {
    const result = this.inputSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid input for tool "${this.name}":\n${issues}`);
    }
    return result.data;
  }

  toJSONSchema(): Record<string, unknown> {
    return zodToJsonSchema(this.inputSchema);
  }

  toDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: this.toJSONSchema(),
    };
  }
}
