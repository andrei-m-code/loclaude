# T-018: Streaming Response Support

## Status: Pending

## Priority: High

## Summary

Implement streaming (token-by-token) response delivery from the LLM provider to the CLI. Instead of waiting for the entire response to be generated before displaying anything, stream tokens to the terminal as they arrive. This dramatically improves perceived responsiveness — the user sees the answer forming in real-time.

## Context

LLM inference is slow, especially on local hardware (Ollama). A full response can take 10-60 seconds. Without streaming, the user stares at a blank screen. With streaming, the first token appears within 1-2 seconds and the response builds naturally.

Both Ollama and OpenAI-compatible APIs support streaming via Server-Sent Events (SSE) or newline-delimited JSON.

## Detailed Implementation

### Provider Streaming Interface

Extend the provider interface (from T-003) to support streaming:

```typescript
interface LLMProvider {
  /** Non-streaming: returns complete response */
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse>;

  /** Streaming: yields tokens and tool calls as they arrive */
  chatStream(messages: Message[], tools?: ToolDefinition[]): AsyncIterable<StreamEvent>;
}

/** Events emitted during streaming */
type StreamEvent =
  | { type: "token"; content: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_args_delta"; id: string; argsDelta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "done"; fullResponse: ChatResponse }
  | { type: "error"; error: Error };
```

### Ollama Streaming

Ollama's `/api/chat` endpoint streams newline-delimited JSON when `stream: true`:

```typescript
async function* ollamaChatStream(
  baseUrl: string,
  request: OllamaChatRequest,
): AsyncIterable<StreamEvent> {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, stream: true }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let currentToolCalls: ToolCall[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // Keep incomplete last line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      const chunk = JSON.parse(line);

      // Ollama streams content in chunk.message.content
      if (chunk.message?.content) {
        fullContent += chunk.message.content;
        yield { type: "token", content: chunk.message.content };
      }

      // Tool calls may come as a complete object or streamed
      if (chunk.message?.tool_calls) {
        for (const tc of chunk.message.tool_calls) {
          yield { type: "tool_call_start", id: tc.id ?? generateId(), name: tc.function.name };
          yield { type: "tool_call_args_delta", id: tc.id, argsDelta: JSON.stringify(tc.function.arguments) };
          yield { type: "tool_call_end", id: tc.id };
          currentToolCalls.push(tc);
        }
      }

      // Check if this is the final chunk
      if (chunk.done) {
        yield {
          type: "done",
          fullResponse: {
            content: fullContent || null,
            toolCalls: currentToolCalls.length > 0 ? currentToolCalls : undefined,
            usage: chunk.eval_count ? {
              promptTokens: chunk.prompt_eval_count ?? 0,
              completionTokens: chunk.eval_count ?? 0,
            } : undefined,
          },
        };
      }
    }
  }
}
```

### Stream Consumer (Agent Loop Integration)

The agent loop must handle streaming responses:

```typescript
async function runAgentTurnStreaming(
  provider: LLMProvider,
  messages: Message[],
  tools: ToolDefinition[],
  callbacks: StreamCallbacks,
): Promise<ChatResponse> {
  let fullContent = "";
  const toolCalls: ToolCall[] = [];
  const toolCallArgBuffers: Map<string, string> = new Map();

  for await (const event of provider.chatStream(messages, tools)) {
    switch (event.type) {
      case "token":
        fullContent += event.content;
        callbacks.onToken?.(event.content);
        break;

      case "tool_call_start":
        toolCallArgBuffers.set(event.id, "");
        callbacks.onToolCallStart?.(event.id, event.name);
        break;

      case "tool_call_args_delta":
        const existing = toolCallArgBuffers.get(event.id) ?? "";
        toolCallArgBuffers.set(event.id, existing + event.argsDelta);
        break;

      case "tool_call_end": {
        const args = toolCallArgBuffers.get(event.id) ?? "{}";
        // Find the name from the start event
        toolCalls.push({
          id: event.id,
          type: "function",
          function: { name: event.name ?? "", arguments: args },
        });
        callbacks.onToolCallEnd?.(event.id);
        break;
      }

      case "done":
        return event.fullResponse;

      case "error":
        throw event.error;
    }
  }

  // If stream ends without a "done" event, construct response from what we have
  return {
    content: fullContent || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

interface StreamCallbacks {
  onToken?: (token: string) => void;
  onToolCallStart?: (id: string, name: string) => void;
  onToolCallEnd?: (id: string) => void;
}
```

### Abort/Cancellation

Support cancelling a streaming response mid-flight (e.g., when user presses Ctrl+C):

```typescript
class AbortableStream<T> implements AsyncIterable<T> {
  private controller: AbortController;
  private inner: AsyncIterable<T>;

  constructor(inner: AsyncIterable<T>, controller: AbortController) {
    this.inner = inner;
    this.controller = controller;
  }

  abort(): void {
    this.controller.abort();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for await (const value of this.inner) {
      if (this.controller.signal.aborted) return;
      yield value;
    }
  }
}
```

### Buffering for Tool Calls

Some models stream tool call arguments character by character. We need to buffer the arguments until the tool call is complete before we can parse and execute:

1. `tool_call_start` → allocate a buffer for this tool call's arguments.
2. `tool_call_args_delta` → append to buffer.
3. `tool_call_end` → parse the buffered JSON, execute the tool.

If the JSON is invalid after buffering is complete, report an error.

### Handling Models Without Streaming Tool Calls

Some Ollama models may not support streaming tool calls — they only stream text and return tool calls in the final chunk. The implementation must handle both cases:

1. **Streaming tool calls**: Events arrive incrementally.
2. **Final-chunk tool calls**: The `done` event contains all tool calls at once.

Both patterns should produce the same result from the consumer's perspective.

## File Locations

- `src/providers/streaming.ts` — Stream types and utilities
- Updates to `src/providers/ollama.ts` — Add `chatStream` method
- Updates to `src/agent/agent.ts` — Integrate streaming into the agent loop

## Acceptance Criteria

1. Text tokens stream to the terminal in real-time.
2. Tool calls are detected and handled correctly during streaming.
3. Abort/cancellation works (Ctrl+C stops the stream).
4. Buffered tool call arguments are parsed correctly.
5. Models that stream tool calls work.
6. Models that only return tool calls in the final chunk work.
7. Graceful handling of stream interruptions (network errors, etc.).
8. Token usage stats are captured from the final event.
9. Integration test with a real Ollama instance.

## Dependencies

- T-003 (Provider Abstraction)
- T-004 (Ollama Provider)
- T-017 (Agent Loop)

## Blocks

- T-020 (CLI streams output to terminal)
