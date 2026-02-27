# T-003: Provider Abstraction Layer

## Status: Pending

## Priority: Critical

## Summary

Design and implement the provider abstraction layer — a set of interfaces and types that decouple the agent logic from any specific LLM provider. This ensures that swapping between Ollama, OpenAI, Anthropic, or any future provider requires zero changes to the agent core, tools, or CLI.

## Context

Different LLM providers have wildly different APIs:
- **Ollama** uses a local REST API (`/api/chat`) with its own message format.
- **OpenAI** uses a cloud REST API (`/v1/chat/completions`) with function calling.
- **Anthropic** uses a cloud REST API (`/v1/messages`) with tool_use content blocks.

Despite these differences, they all fundamentally do the same thing: accept a conversation (messages), optionally with tool definitions, and return a response that may include text and/or tool calls.

Our abstraction must capture this common denominator while allowing provider-specific features to be passed through.

## Detailed Requirements

### Core Interfaces

#### `LLMProvider` Interface

```typescript
interface LLMProvider {
  readonly name: string;           // e.g., "ollama", "openai", "anthropic"
  readonly displayName: string;    // e.g., "Ollama (local)", "OpenAI"

  /**
   * Send a chat completion request to the provider.
   * Returns a complete response (non-streaming).
   */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /**
   * Send a chat completion request and stream the response.
   * Yields chunks as they arrive.
   */
  chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk>;

  /**
   * List available models from this provider.
   */
  listModels(): Promise<ModelInfo[]>;

  /**
   * Check if the provider is reachable and configured correctly.
   */
  healthCheck(): Promise<HealthCheckResult>;
}
```

#### `ChatRequest` Type

```typescript
interface ChatRequest {
  model: string;                    // Model identifier (e.g., "llama3.1", "gpt-4o")
  messages: Message[];              // Conversation history
  tools?: ToolDefinition[];         // Available tools the model can call
  systemPrompt?: string;           // System-level instructions
  temperature?: number;            // 0-2, controls randomness
  maxTokens?: number;              // Max tokens in response
  stop?: string[];                 // Stop sequences
}
```

#### `Message` Types

```typescript
type MessageRole = "system" | "user" | "assistant" | "tool";

interface TextContent {
  type: "text";
  text: string;
}

interface ToolCallContent {
  type: "tool_call";
  toolCallId: string;             // Unique ID for this tool invocation
  toolName: string;               // Name of the tool being called
  arguments: Record<string, unknown>; // Parsed arguments
}

interface ToolResultContent {
  type: "tool_result";
  toolCallId: string;             // Must match the tool_call it responds to
  result: string;                 // Stringified result
  isError?: boolean;              // Whether the tool execution failed
}

type MessageContent = TextContent | ToolCallContent | ToolResultContent;

interface Message {
  role: MessageRole;
  content: MessageContent[];
}
```

#### `ChatResponse` and Streaming Types

```typescript
interface ChatResponse {
  message: Message;                // The assistant's response message
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: "stop" | "tool_calls" | "length" | "error";
  raw?: unknown;                   // Raw provider response for debugging
}

interface ChatStreamChunk {
  type: "text_delta" | "tool_call_start" | "tool_call_delta" | "tool_call_end" | "done" | "error";
  // For text_delta:
  text?: string;
  // For tool_call_start:
  toolCallId?: string;
  toolName?: string;
  // For tool_call_delta:
  argumentsDelta?: string;         // Partial JSON of arguments
  // For error:
  error?: Error;
  // For done:
  usage?: ChatResponse["usage"];
  finishReason?: ChatResponse["finishReason"];
}
```

#### `ToolDefinition` Type

```typescript
interface ToolDefinition {
  name: string;                    // Tool name (e.g., "file_read")
  description: string;            // What the tool does (sent to the model)
  parameters: JSONSchema;          // JSON Schema describing the input parameters
}

type JSONSchema = Record<string, unknown>; // Standard JSON Schema object
```

#### `ModelInfo` and `HealthCheckResult`

```typescript
interface ModelInfo {
  id: string;                      // Model identifier
  name: string;                    // Human-readable name
  size?: number;                   // Model size in bytes (if known)
  quantization?: string;           // e.g., "Q4_K_M" (Ollama-specific but useful)
  modifiedAt?: Date;              // Last modified date
}

interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  version?: string;                // Provider/server version
}
```

### Provider Factory

```typescript
interface ProviderConfig {
  provider: "ollama" | "openai" | "anthropic";
  baseUrl?: string;               // Override default URL
  apiKey?: string;                // For cloud providers
  defaultModel?: string;          // Default model to use
  options?: Record<string, unknown>; // Provider-specific options
}

function createProvider(config: ProviderConfig): LLMProvider;
```

## File Locations

- `src/providers/types.ts` — All interfaces and types above.
- `src/providers/factory.ts` — `createProvider()` function.
- `src/providers/base.ts` — Optional abstract base class with shared logic (e.g., retry, timeout).

## Acceptance Criteria

1. All interfaces and types defined in `src/providers/types.ts` with JSDoc comments.
2. `createProvider()` factory function implemented (initially only supports "ollama", throws for others).
3. Types are exported and importable from other modules.
4. A base provider class with common utilities:
   - Request timeout handling.
   - Basic retry logic (configurable retries, exponential backoff).
   - Error normalization (convert provider-specific errors to a common `ProviderError` type).
5. Unit tests for the factory function.

## Implementation Notes

- Keep types as close to the "lowest common denominator" as possible. Provider-specific features should use the `raw` escape hatch or provider-specific config.
- The `Message` type uses a content array (not a simple string) to support mixed content (text + tool calls in a single message). This matches how Anthropic and OpenAI both work.
- `toolCallId` is critical for matching tool results back to their calls. Ollama doesn't natively use IDs, so the Ollama provider will need to generate them.
- JSON Schema for tool parameters should be a plain object — we'll use Zod internally but convert to JSON Schema for the provider API.

## Dependencies

- T-001 (project scaffolding must exist)

## Blocks

- T-004 (Ollama provider needs these interfaces)
- T-017 (Agent loop needs ChatRequest/ChatResponse)
- T-006+ (All tools need ToolDefinition)
