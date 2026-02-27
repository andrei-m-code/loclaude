# T-017: Core Agent Loop

## Status: Pending

## Priority: Critical

## Summary

Implement the core agent loop — the central orchestration engine that drives the think → act → observe cycle. This is the brain of the system: it takes user input, sends it to the LLM with available tools, processes tool calls, feeds results back, and repeats until the LLM produces a final text response.

## Context

The agent loop is the most critical piece of the system. It sits between the CLI (user input) and the LLM provider, orchestrating multi-turn conversations that may involve multiple rounds of tool use.

### The Agent Loop Cycle

```
User Input
    ↓
┌─────────────────────┐
│  Prepare Messages    │ ← Append user message to conversation history
│  (system prompt +    │
│   history + tools)   │
└─────────┬───────────┘
          ↓
┌─────────────────────┐
│  Call LLM Provider   │ ← chatStream() with messages + tool definitions
│  (streaming)         │
└─────────┬───────────┘
          ↓
┌─────────────────────┐
│  Process Response    │ ← Stream text to terminal, collect tool calls
└─────────┬───────────┘
          ↓
    ┌─────┴─────┐
    │ Has tool  │
    │  calls?   │
    └─────┬─────┘
     Yes  │  No
      ↓       ↓
┌──────────┐  ┌──────────────┐
│ Execute  │  │ Done — yield │
│ tools    │  │ final text   │
└────┬─────┘  └──────────────┘
     ↓
┌──────────────┐
│ Append tool  │
│ results to   │
│ conversation │
└──────┬───────┘
       ↓
  Loop back to "Call LLM Provider"
```

## Detailed Implementation

### Class: `Agent`

```typescript
class Agent {
  private provider: LLMProvider;
  private toolRegistry: ToolRegistry;
  private conversation: Conversation;
  private config: AgentConfig;

  constructor(options: {
    provider: LLMProvider;
    toolRegistry: ToolRegistry;
    config: AgentConfig;
  });

  /**
   * Process a user message through the full agent loop.
   * Yields events as they happen (text chunks, tool calls, tool results, etc.)
   */
  async *run(userMessage: string): AsyncIterable<AgentEvent> { ... }

  /**
   * Reset the conversation (clear history).
   */
  reset(): void;

  /**
   * Get the current conversation history.
   */
  getHistory(): Message[];
}
```

### Agent Events

The agent loop communicates everything through a stream of typed events. This decouples the agent from the presentation layer (CLI, future GUI, etc.).

```typescript
type AgentEvent =
  | { type: "text_delta"; text: string }                    // Streaming text chunk
  | { type: "text_done"; fullText: string }                 // Text generation complete
  | { type: "tool_call_start"; toolName: string; toolCallId: string }  // Starting a tool call
  | { type: "tool_call_args_delta"; delta: string }         // Streaming tool arguments
  | { type: "tool_call_ready"; toolName: string; toolCallId: string; args: Record<string, unknown> }  // Tool call fully parsed, about to execute
  | { type: "tool_result"; toolCallId: string; toolName: string; result: string; isError: boolean }    // Tool execution result
  | { type: "turn_complete"; turnNumber: number }           // One LLM turn finished
  | { type: "loop_complete"; totalTurns: number }           // Agent loop fully done
  | { type: "error"; error: Error }                         // Error occurred
  | { type: "warning"; message: string };                   // Non-fatal warning
```

### The Run Loop (Pseudocode)

```typescript
async *run(userMessage: string): AsyncIterable<AgentEvent> {
  // 1. Add user message to conversation
  this.conversation.addUserMessage(userMessage);

  let turnNumber = 0;
  const maxTurns = this.config.maxTurns ?? 25;  // Safety limit

  while (turnNumber < maxTurns) {
    turnNumber++;

    // 2. Build the request
    const request: ChatRequest = {
      model: this.config.model,
      messages: this.conversation.getMessages(),
      tools: this.toolRegistry.getToolDefinitions(),
      systemPrompt: this.config.systemPrompt,
      temperature: this.config.temperature ?? 0,
      maxTokens: this.config.maxTokens,
    };

    // 3. Call the LLM (streaming)
    let fullText = "";
    const toolCalls: ToolCallContent[] = [];
    let currentToolCall: Partial<ToolCallContent> | null = null;
    let toolCallArgsBuffer = "";

    for await (const chunk of this.provider.chatStream(request)) {
      switch (chunk.type) {
        case "text_delta":
          fullText += chunk.text;
          yield { type: "text_delta", text: chunk.text };
          break;

        case "tool_call_start":
          currentToolCall = {
            type: "tool_call",
            toolCallId: chunk.toolCallId!,
            toolName: chunk.toolName!,
          };
          toolCallArgsBuffer = "";
          yield { type: "tool_call_start", toolName: chunk.toolName!, toolCallId: chunk.toolCallId! };
          break;

        case "tool_call_delta":
          toolCallArgsBuffer += chunk.argumentsDelta;
          yield { type: "tool_call_args_delta", delta: chunk.argumentsDelta! };
          break;

        case "tool_call_end":
          const args = JSON.parse(toolCallArgsBuffer);
          const completedCall: ToolCallContent = {
            ...currentToolCall,
            arguments: args,
          };
          toolCalls.push(completedCall);
          yield { type: "tool_call_ready", toolName: completedCall.toolName, toolCallId: completedCall.toolCallId, args };
          currentToolCall = null;
          break;

        case "error":
          yield { type: "error", error: chunk.error! };
          return;

        case "done":
          break;
      }
    }

    // 4. Add assistant message to conversation
    const assistantContent: MessageContent[] = [];
    if (fullText) {
      assistantContent.push({ type: "text", text: fullText });
    }
    assistantContent.push(...toolCalls);
    this.conversation.addAssistantMessage(assistantContent);

    if (fullText) {
      yield { type: "text_done", fullText };
    }

    // 5. If no tool calls, we're done
    if (toolCalls.length === 0) {
      yield { type: "turn_complete", turnNumber };
      yield { type: "loop_complete", totalTurns: turnNumber };
      return;
    }

    // 6. Execute tool calls
    for (const toolCall of toolCalls) {
      const result = await this.executeTool(toolCall);
      yield {
        type: "tool_result",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        result: result.result,
        isError: result.isError,
      };

      // Add tool result to conversation
      this.conversation.addToolResult(toolCall.toolCallId, result.result, result.isError);
    }

    yield { type: "turn_complete", turnNumber };

    // Loop continues — LLM will see the tool results and either respond or call more tools
  }

  // Safety: max turns reached
  yield { type: "warning", message: `Agent reached maximum turns (${maxTurns}). Stopping.` };
  yield { type: "loop_complete", totalTurns: turnNumber };
}
```

### Tool Execution

```typescript
private async executeTool(toolCall: ToolCallContent): Promise<{ result: string; isError: boolean }> {
  const tool = this.toolRegistry.getTool(toolCall.toolName);

  if (!tool) {
    return {
      result: `Error: Unknown tool "${toolCall.toolName}". Available tools: ${this.toolRegistry.getToolNames().join(", ")}`,
      isError: true,
    };
  }

  try {
    // Validate arguments against schema
    const validatedArgs = tool.validateInput(toolCall.arguments);

    // Execute the tool
    const result = await tool.execute(validatedArgs);
    return { result: result.output, isError: false };
  } catch (error) {
    return {
      result: `Error executing tool "${toolCall.toolName}": ${error.message}`,
      isError: true,
    };
  }
}
```

### AgentConfig

```typescript
interface AgentConfig {
  model: string;                   // Model to use (e.g., "llama3.1")
  systemPrompt: string;           // System prompt defining agent behavior
  temperature?: number;           // Default: 0 (deterministic)
  maxTokens?: number;             // Max tokens per response
  maxTurns?: number;              // Max agent loop iterations (default: 25)
}
```

### System Prompt

The system prompt is critical for agent behavior. It should instruct the model to:
1. Use tools to accomplish tasks rather than guessing.
2. Read files before editing them.
3. Be precise and avoid unnecessary changes.
4. Explain what it's doing as it works.

A starting system prompt (to be refined):

```
You are an AI coding assistant with access to tools for file operations, code search, shell commands, and HTTP requests. You help users with software engineering tasks.

When working on tasks:
- Always read files before modifying them to understand the current state.
- Use the appropriate tool for each action — do not guess file contents or command outputs.
- Explain your reasoning and what you're about to do before taking action.
- If a task is ambiguous, ask for clarification.
- Keep changes minimal and focused on what was asked.
- After making changes, verify them if possible (e.g., run tests, read the file back).

Available tools are provided in each request. Use them as needed.
```

### Agent Cancellation (Ctrl+C)

When the user presses Ctrl+C during an agent turn:

1. **During streaming**: Abort the provider request via AbortController. Display partial response. Add partial content to history.
2. **During tool execution**: Send SIGTERM to any running child processes (bash tool). Mark tool result as "cancelled". Continue to the next REPL prompt.
3. **Between turns**: Cancel the entire multi-turn loop. Show summary of what was done so far.

The cancellation signal propagates through the agent → provider → HTTP fetch chain via AbortController.

### Tool Argument Validation

Before executing a tool, validate the LLM's arguments against the tool's Zod schema:

1. Parse `tool_call.function.arguments` as JSON. If invalid JSON, report parse error back to LLM.
2. Validate parsed args against the tool's input schema. If validation fails, report the Zod error details back to LLM so it can correct its call.
3. If validation passes, execute the tool.

This prevents runtime errors from invalid arguments and gives the LLM a chance to self-correct.

## Acceptance Criteria

1. `Agent` class implemented with the `run()` async generator method.
2. The agent loop correctly cycles through: LLM call → tool execution → LLM call → ... → final response.
3. Tool calls are correctly parsed, executed, and results fed back.
4. Multiple tool calls in a single response are handled (executed sequentially).
5. Max turns safety limit works and emits a warning.
6. All events are emitted correctly and in order.
7. Conversation history is properly maintained across turns.
8. Error handling: LLM errors, tool execution errors, and malformed tool calls are all handled gracefully.
9. Unit tests with a mock provider that returns scripted responses (including tool calls).
10. Integration test: send a message that triggers a tool call and verify the full cycle works.

## Testing Strategy

Create a `MockProvider` that implements `LLMProvider` and returns predefined responses. This allows testing the agent loop without a real LLM.

Test scenarios:
1. Simple text response (no tool calls) — 1 turn.
2. Single tool call → result → final text — 2 turns.
3. Multiple tool calls in one response → results → final text — 2 turns.
4. Multi-turn: tool call → result → another tool call → result → text — 3 turns.
5. Max turns exceeded.
6. Tool not found.
7. Tool execution error.
8. LLM error mid-stream.

## Dependencies

- T-001 (project setup)
- T-003 (provider types)
- T-004 (at least one working provider, but can use MockProvider for testing)
- T-006 (tool registry — or implement a minimal version inline)

## Blocks

- T-020 (CLI REPL depends on the agent loop to process user input)
- T-016 (system prompt refinement depends on agent loop working)
