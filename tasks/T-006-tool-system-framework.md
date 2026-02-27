# T-006: Tool System Framework

## Status: Pending

## Priority: Critical

## Summary

Implement the tool system framework — the infrastructure that defines how tools are created, registered, validated, and executed. This includes the `Tool` interface, the `ToolRegistry` for managing tools, input validation using Zod schemas, and the JSON Schema conversion needed to send tool definitions to LLM providers.

## Context

Tools are the agent's hands. Without them, the LLM can only generate text. With tools, it can read files, write code, run commands, search codebases, and make HTTP requests.

Every tool follows the same lifecycle:
1. **Definition** — The tool declares its name, description, and input schema.
2. **Registration** — The tool is registered with the `ToolRegistry` at startup.
3. **Serialization** — When calling the LLM, tool definitions are converted to JSON Schema format.
4. **Invocation** — The LLM returns a tool call; the agent validates inputs and executes the tool.
5. **Result** — The tool returns a string result that's fed back to the LLM.

## Detailed Implementation

### Tool Interface

```typescript
import { z } from "zod";

interface Tool<TInput = unknown> {
  /** Unique tool name (snake_case, e.g., "file_read") */
  readonly name: string;

  /** Human-readable description shown to the LLM */
  readonly description: string;

  /** Zod schema defining the tool's input parameters */
  readonly inputSchema: z.ZodType<TInput>;

  /**
   * Execute the tool with validated input.
   * Returns a ToolResult containing the output string.
   */
  execute(input: TInput): Promise<ToolResult>;
}

interface ToolResult {
  /** String output to send back to the LLM */
  output: string;

  /** Optional metadata (not sent to LLM, used for logging/display) */
  metadata?: Record<string, unknown>;
}
```

### Tool Base Class

A convenience base class to reduce boilerplate:

```typescript
abstract class BaseTool<TInput> implements Tool<TInput> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly inputSchema: z.ZodType<TInput>;

  abstract execute(input: TInput): Promise<ToolResult>;

  /** Validate raw input against the schema */
  validateInput(raw: unknown): TInput {
    const result = this.inputSchema.safeParse(raw);
    if (!result.success) {
      throw new ToolValidationError(this.name, result.error);
    }
    return result.data;
  }

  /** Convert Zod schema to JSON Schema for the LLM provider */
  toJSONSchema(): Record<string, unknown> {
    return zodToJsonSchema(this.inputSchema);
  }

  /** Convert to ToolDefinition for the provider */
  toDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: this.toJSONSchema(),
    };
  }
}
```

### ToolRegistry

```typescript
class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /** Register a tool. Throws if name already registered. */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Get a tool by name. Returns undefined if not found. */
  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Get all registered tool names. */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /** Get all tool definitions (for sending to LLM). */
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: (tool as BaseTool<unknown>).toJSONSchema(),
    }));
  }

  /** Execute a tool by name with raw (unvalidated) input. */
  async executeTool(name: string, rawInput: unknown): Promise<ToolResult> {
    const tool = this.getTool(name);
    if (!tool) {
      throw new ToolNotFoundError(name, this.getToolNames());
    }

    const validatedInput = (tool as BaseTool<unknown>).validateInput(rawInput);
    return tool.execute(validatedInput);
  }

  /** Get the count of registered tools. */
  get size(): number {
    return this.tools.size;
  }
}
```

### Zod to JSON Schema Conversion

We need to convert Zod schemas to JSON Schema for the LLM API. Use the `zod-to-json-schema` package:

```typescript
import { zodToJsonSchema as zodToJsonSchemaLib } from "zod-to-json-schema";

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = zodToJsonSchemaLib(schema, {
    target: "openApi3",  // Most compatible format
    $refStrategy: "none", // Inline all references (LLMs don't handle $ref)
  });

  // Remove the top-level $schema property (not needed by LLM APIs)
  const { $schema, ...rest } = jsonSchema as Record<string, unknown>;
  return rest;
}
```

### Custom Error Types

```typescript
class ToolValidationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly zodError: z.ZodError,
  ) {
    const issues = zodError.issues
      .map(i => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    super(`Invalid input for tool "${toolName}":\n${issues}`);
    this.name = "ToolValidationError";
  }
}

class ToolNotFoundError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly availableTools: string[],
  ) {
    super(
      `Tool "${toolName}" not found. Available tools: ${availableTools.join(", ")}`
    );
    this.name = "ToolNotFoundError";
  }
}

class ToolExecutionError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly cause: Error,
  ) {
    super(`Tool "${toolName}" failed: ${cause.message}`);
    this.name = "ToolExecutionError";
  }
}
```

### Example Tool (for testing)

```typescript
class EchoTool extends BaseTool<{ message: string }> {
  readonly name = "echo";
  readonly description = "Echoes back the input message. Useful for testing.";
  readonly inputSchema = z.object({
    message: z.string().describe("The message to echo back"),
  });

  async execute(input: { message: string }): Promise<ToolResult> {
    return { output: input.message };
  }
}
```

### Default Tool Registration

```typescript
function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // Register all built-in tools
  registry.register(new FileReadTool());
  registry.register(new FileWriteTool());
  registry.register(new FileEditTool());
  registry.register(new FileDeleteTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  registry.register(new BashTool());
  registry.register(new HttpRequestTool());

  return registry;
}
```

## File Locations

- `src/tools/types.ts` — `Tool`, `ToolResult`, `BaseTool`, error classes
- `src/tools/registry.ts` — `ToolRegistry`, `createDefaultRegistry()`
- `src/tools/schema.ts` — `zodToJsonSchema()` utility
- `src/tools/echo.ts` — Example `EchoTool` for testing

## Acceptance Criteria

1. `Tool` interface and `BaseTool` abstract class implemented.
2. `ToolRegistry` implemented with register, get, list, execute, and getDefinitions methods.
3. Zod → JSON Schema conversion works correctly for:
   - Primitive types (string, number, boolean)
   - Objects with required and optional fields
   - Arrays
   - Enums
   - Nested objects
   - Field descriptions (these are critical — the LLM needs them)
4. Custom error types implemented with helpful messages.
5. `EchoTool` implemented and works end-to-end.
6. `createDefaultRegistry()` function exists (initially just registers EchoTool — real tools added in later tasks).
7. All unit tests passing:
   - Register and retrieve tools
   - Duplicate registration throws
   - Input validation (valid input, invalid input, missing required fields)
   - JSON Schema generation correctness
   - Tool execution success and failure

## Additional Dependencies (npm)

- `zod` — Runtime schema validation
- `zod-to-json-schema` — Convert Zod schemas to JSON Schema

## Dependencies

- T-001 (project setup)
- T-003 (needs ToolDefinition type)

## Blocks

- T-007 through T-013 (all individual tools depend on this framework)
- T-017 (agent loop needs ToolRegistry)
