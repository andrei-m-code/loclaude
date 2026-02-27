# T-015: Conversation Management and Context Window

## Status: Pending

## Priority: Critical

## Summary

Implement the conversation manager that maintains the message history between the user, the assistant (LLM), and tool results. This component is responsible for building the message list sent to the provider on each turn, managing context window limits, and handling multi-turn tool-use loops.

## Context

The agent operates in a loop:
1. User sends a message.
2. Agent builds a message list (system prompt + history + user message) and sends it to the LLM.
3. LLM responds — either with text (done) or with tool calls (continue).
4. If tool calls: execute each tool, append tool results to history, go to step 2.
5. If text: show to user, wait for next input.

The conversation manager owns the message history and is the bridge between the CLI (user I/O), the agent loop, and the provider.

## Detailed Implementation

### Message Types

Following the OpenAI/Ollama chat format (which is the de facto standard):

```typescript
/** Roles in the conversation */
type Role = "system" | "user" | "assistant" | "tool";

/** A text message from user or assistant */
interface TextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** An assistant message that includes tool calls */
interface ToolCallMessage {
  role: "assistant";
  content: string | null;
  tool_calls: ToolCall[];
}

/** A tool result message */
interface ToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/** Union of all message types */
type Message = TextMessage | ToolCallMessage | ToolResultMessage;

/** A tool call requested by the assistant */
interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}
```

### ConversationManager Class

```typescript
class ConversationManager {
  private systemPrompt: string;
  private messages: Message[] = [];
  private maxContextTokens: number;     // Provider-specific limit
  private reservedForResponse: number;  // Tokens reserved for the response

  constructor(options: {
    systemPrompt: string;
    maxContextTokens: number;
    reservedForResponse?: number;
  }) {
    this.systemPrompt = options.systemPrompt;
    this.maxContextTokens = options.maxContextTokens;
    this.reservedForResponse = options.reservedForResponse ?? 4096;
  }

  /** Add a user message */
  addUserMessage(content: string): void {
    this.messages.push({ role: "user", content });
  }

  /** Add an assistant text response */
  addAssistantMessage(content: string): void {
    this.messages.push({ role: "assistant", content });
  }

  /** Add an assistant response that contains tool calls */
  addToolCallMessage(content: string | null, toolCalls: ToolCall[]): void {
    this.messages.push({
      role: "assistant",
      content,
      tool_calls: toolCalls,
    } as ToolCallMessage);
  }

  /** Add a tool result */
  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({
      role: "tool",
      tool_call_id: toolCallId,
      content,
    });
  }

  /**
   * Build the message list to send to the provider.
   * This includes the system prompt, conversation history (possibly truncated),
   * and ensures we stay within the context window.
   */
  buildMessageList(): Message[] {
    const systemMessage: TextMessage = {
      role: "system",
      content: this.systemPrompt,
    };

    const availableTokens = this.maxContextTokens - this.reservedForResponse;
    const systemTokens = this.estimateTokens(this.systemPrompt);
    let remainingTokens = availableTokens - systemTokens;

    // Include messages from most recent to oldest, stopping when we run out of tokens.
    // Always include the most recent user message and any pending tool interactions.
    const includedMessages: Message[] = [];

    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      const tokens = this.estimateMessageTokens(msg);

      if (remainingTokens - tokens < 0 && includedMessages.length > 0) {
        // We've run out of room. Stop including older messages.
        break;
      }

      includedMessages.unshift(msg);
      remainingTokens -= tokens;
    }

    return [systemMessage, ...includedMessages];
  }

  /** Get full message history (for display/debugging) */
  getHistory(): ReadonlyArray<Message> {
    return this.messages;
  }

  /** Clear all messages (start fresh) */
  clear(): void {
    this.messages = [];
  }

  /**
   * Rough token estimation.
   * Rule of thumb: ~4 characters per token for English text.
   * This is intentionally conservative — better to truncate a little early
   * than to exceed the context window.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }

  private estimateMessageTokens(msg: Message): number {
    let text = "";
    if (typeof msg.content === "string") text += msg.content;
    if ("tool_calls" in msg && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        text += tc.function.name + tc.function.arguments;
      }
    }
    return this.estimateTokens(text) + 10; // +10 for message overhead
  }
}
```

### Context Window Management Strategy

When the conversation grows beyond the context limit:

1. **Always keep**: System prompt + most recent user message + any pending tool call/result chain.
2. **Truncation order**: Remove oldest messages first.
3. **Preserve coherence**: Never split a tool-call / tool-result pair. If an assistant message with tool_calls is included, all corresponding tool result messages must also be included.
4. **Summarization (future)**: Optionally, summarize dropped messages into a "conversation so far" summary prepended to the system prompt. This is a future enhancement.

### Message Addition Timing

Messages are added to history at specific points in the lifecycle:
- **User message**: Added immediately when the user submits input.
- **Assistant text**: Added after streaming completes (full text accumulated).
- **Assistant tool_calls**: Added immediately when tool calls are detected (before execution).
- **Tool results**: Added one at a time as each tool completes execution.

This ensures that if the agent is interrupted mid-stream, we have a consistent history up to the last completed action.

### Model-Specific Context Windows

Different models have different context window sizes. The conversation manager must respect the model's limit:

| Model | Context Window |
|-------|---------------|
| llama3.1:8b | 128K tokens |
| llama3.2:3b | 128K tokens |
| mistral:7b | 32K tokens |
| phi3:mini | 4K tokens |
| codellama | 16K tokens |

These defaults can be overridden via `provider.contextWindow` in config. The Ollama `/api/show` endpoint returns the model's context length in its parameters.

### Tool Call Chain Integrity

A critical invariant: **tool_call messages and their corresponding tool_result messages must always appear together**. The LLM expects this. If we truncate the history and an assistant message with `tool_calls` is included but its results are dropped (or vice versa), the LLM will be confused.

Algorithm for safe truncation:
1. Walk messages from newest to oldest.
2. Track which tool_call IDs are "open" (have a tool_calls message but no result yet in the included set, or have a result but no call).
3. If including a tool_result, mark its tool_call_id as needing the corresponding assistant message.
4. If including an assistant tool_calls message, mark all its call IDs as needing results.
5. Continue including messages until all open IDs are resolved or we run out of budget.

### System Prompt

The system prompt is constructed at conversation start and includes:
- Agent identity and capabilities description
- List of available tools with their descriptions and schemas
- Working directory and environment info
- User preferences / configuration

The system prompt is built by a separate module (T-016) but stored and managed here.

## File Location

- `src/agent/conversation.ts`
- `src/agent/types.ts` (shared message types)

## Acceptance Criteria

1. Messages are stored in order and retrievable.
2. `buildMessageList()` returns system + history within token budget.
3. Oldest messages are dropped first when context is full.
4. Tool call/result pairs are never split during truncation.
5. Token estimation is reasonable (within 2x of actual for typical text).
6. Clear/reset works.
7. All message types (text, tool_call, tool_result) work correctly.
8. Unit tests for:
   - Basic message adding and retrieval
   - Context truncation with long history
   - Tool call chain integrity during truncation
   - Token estimation

## Dependencies

- T-001

## Blocks

- T-017 (Agent Loop uses this directly)
- T-016 (System Prompt is stored here)
