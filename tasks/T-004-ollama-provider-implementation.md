# T-004: Ollama Provider Implementation

## Status: Pending

## Priority: Critical

## Summary

Implement the Ollama provider — the concrete `LLMProvider` implementation that communicates with a locally-running Ollama server. This is the first and primary provider for our POC. It must handle chat completions (with and without streaming), tool calling, model listing, and health checks.

## Context

Ollama runs locally and exposes a REST API at `http://localhost:11434`. The key endpoints we need:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/chat` | POST | Chat completion (streaming or non-streaming) |
| `/api/tags` | GET | List locally available models |
| `/` | GET | Health check (returns "Ollama is running") |
| `/api/show` | POST | Get model details |

### Ollama Chat API — Request Format

```json
{
  "model": "llama3.1",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi there!"}
  ],
  "stream": true,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "file_read",
        "description": "Read a file from disk",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {"type": "string", "description": "Absolute file path"}
          },
          "required": ["path"]
        }
      }
    }
  ],
  "options": {
    "temperature": 0.7,
    "num_predict": 4096
  }
}
```

### Ollama Chat API — Response Format (non-streaming)

```json
{
  "model": "llama3.1",
  "created_at": "2024-01-01T00:00:00Z",
  "message": {
    "role": "assistant",
    "content": "Here is the file content...",
    "tool_calls": [
      {
        "function": {
          "name": "file_read",
          "arguments": {"path": "/tmp/test.txt"}
        }
      }
    ]
  },
  "done": true,
  "total_duration": 1234567890,
  "eval_count": 150,
  "prompt_eval_count": 50
}
```

### Ollama Chat API — Response Format (streaming)

Each line is a JSON object:
```json
{"model":"llama3.1","created_at":"...","message":{"role":"assistant","content":"Here"},"done":false}
{"model":"llama3.1","created_at":"...","message":{"role":"assistant","content":" is"},"done":false}
{"model":"llama3.1","created_at":"...","message":{"role":"assistant","content":""},"done":true,"total_duration":...}
```

For tool calls during streaming, the message will contain `tool_calls` in the chunks.

### Ollama Tool Call Behavior — Important Notes

1. Ollama does NOT assign IDs to tool calls. We must generate our own UUIDs.
2. When the model wants to call a tool, it returns the tool call in the `message.tool_calls` array.
3. Tool results must be sent back as a message with `role: "tool"`.
4. Not all Ollama models support tool calling. Models that do: `llama3.1`, `llama3.2`, `qwen2.5`, `mistral`, `command-r`, etc. The agent should gracefully handle models that don't support tools.
5. Ollama tool call arguments are returned as an object, not a JSON string (unlike OpenAI).

## Detailed Implementation

### Class: `OllamaProvider`

```typescript
class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  readonly displayName = "Ollama (local)";

  private baseUrl: string;        // Default: http://localhost:11434
  private defaultModel: string;   // Default: llama3.1

  constructor(config: OllamaConfig);

  // Convert our Message[] → Ollama message format
  private toOllamaMessages(messages: Message[]): OllamaMessage[];

  // Convert our ToolDefinition[] → Ollama tool format
  private toOllamaTools(tools: ToolDefinition[]): OllamaTool[];

  // Convert Ollama response → our ChatResponse
  private fromOllamaResponse(raw: OllamaChatResponse): ChatResponse;

  // Convert streaming chunks → our ChatStreamChunk
  private parseStreamChunk(line: string): ChatStreamChunk | null;

  // Generate a UUID for tool calls (Ollama doesn't provide IDs)
  private generateToolCallId(): string;
}
```

### Streaming Implementation

The streaming implementation must:

1. Use `fetch()` with the native Node.js streaming API.
2. Read the response body as a stream of newline-delimited JSON (NDJSON).
3. Parse each line into a `ChatStreamChunk`.
4. Handle partial lines (chunks may split across network packets).
5. Properly signal completion with a `done` chunk.
6. Handle connection errors and timeouts gracefully.

```typescript
async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
  const response = await fetch(`${this.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: request.model ?? this.defaultModel,
      messages: this.toOllamaMessages(request.messages),
      tools: request.tools ? this.toOllamaTools(request.tools) : undefined,
      stream: true,
      options: {
        temperature: request.temperature,
        num_predict: request.maxTokens,
        stop: request.stop,
      },
    }),
  });

  if (!response.ok) {
    throw new ProviderError(`Ollama returned ${response.status}`, ...);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // Keep incomplete last line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      const chunk = this.parseStreamChunk(line);
      if (chunk) yield chunk;
    }
  }
}
```

### Message Format Translation

Key translations between our format and Ollama's:

| Our Format | Ollama Format |
|------------|---------------|
| `MessageContent[]` with `type: "text"` | `content: string` |
| `MessageContent[]` with `type: "tool_call"` | `tool_calls: [{function: {name, arguments}}]` |
| `role: "tool"` with `type: "tool_result"` | `role: "tool"`, `content: string` |
| `systemPrompt` on request | First message with `role: "system"` |

### Error Handling

The provider must handle:
- **Connection refused** — Ollama not running → clear error message: "Cannot connect to Ollama at http://localhost:11434. Is Ollama running?"
- **Model not found** — 404 → "Model 'xyz' not found. Run `ollama pull xyz` to download it."
- **Timeout** — Request taking too long → configurable timeout with sensible default (120s for generation).
- **Malformed response** — Invalid JSON in stream → skip line, log warning, continue.
- **Model doesn't support tools** — Detect and warn the user, fall back to prompt-based tool use or error.

## File Location

- `src/providers/ollama.ts`

### Auto-Pull Missing Models

When a model is not found locally, the agent should offer to pull it:

1. Detect `404` or model-not-found from `/api/show`.
2. Prompt the user: `Model "codellama" not found. Pull it now? [Y/n]`
3. If yes, call `POST /api/pull` with `{"name": "codellama"}` and stream progress.
4. If no, exit with the model-not-found error.

This is a convenience feature — not critical for POC but improves UX significantly.

## Acceptance Criteria

1. `OllamaProvider` class fully implements the `LLMProvider` interface.
2. **Non-streaming chat** works: sends request, receives response, correctly maps to `ChatResponse`.
3. **Streaming chat** works: yields `ChatStreamChunk` objects in real-time as Ollama generates tokens.
4. **Tool calling** works:
   - Tool definitions are correctly translated to Ollama format.
   - Tool calls in responses are parsed with generated IDs.
   - Tool results can be sent back in follow-up messages.
5. **`listModels()`** returns available models from the Ollama server.
6. **`healthCheck()`** verifies the Ollama server is reachable and returns latency.
7. All error cases handled with descriptive messages.
8. Integration tests that run against a live Ollama instance (skippable via env var if Ollama not available).
- [ ] Auto-pull flow prompts user and streams download progress.

## Testing Strategy

- **Unit tests**: Mock `fetch` to test message translation, response parsing, stream parsing, error handling.
- **Integration tests**: Against a real Ollama server (guard with `OLLAMA_AVAILABLE` env var check).
  - Test basic chat completion.
  - Test streaming.
  - Test tool calling round-trip.
  - Test listing models.
  - Test health check.

## Dependencies

- T-001 (project setup)
- T-003 (provider interfaces)

## Blocks

- T-017 (agent loop needs a working provider)
- T-015 (streaming rendering needs streaming to work)
