import type { LLMProvider, ChatStreamChunk, ToolCallContent } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ConversationManager } from "./conversation.js";
import { MaxTurnsExceededError } from "../errors/index.js";
import { ToolCallMode, detectToolCallMode } from "../providers/tool-capability.js";
import {
  buildFallbackToolPrompt,
  parseFallbackToolCalls,
  buildFallbackToolResultMessage,
} from "../providers/tool-fallback.js";

// -- Agent Events --

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "text_done"; fullText: string }
  | { type: "tool_call_start"; toolName: string; toolCallId: string }
  | { type: "tool_call_args_delta"; toolCallId: string; delta: string }
  | {
      type: "tool_call_ready";
      toolName: string;
      toolCallId: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      toolName: string;
      result: string;
      isError: boolean;
    }
  | { type: "turn_complete"; turnNumber: number }
  | { type: "loop_complete"; totalTurns: number }
  | { type: "error"; error: Error }
  | { type: "warning"; message: string };

// -- Agent Config --

export interface AgentConfig {
  model: string;
  systemPrompt: string;
  baseUrl: string;
  temperature?: number;
  maxTokens?: number;
  maxTurns?: number;
}

// -- Agent --

export class Agent {
  private provider: LLMProvider;
  private toolRegistry: ToolRegistry;
  private conversation: ConversationManager;
  private config: AgentConfig;
  private maxTurns: number;
  private toolCallMode: ToolCallMode | null = null;

  constructor(options: {
    provider: LLMProvider;
    toolRegistry: ToolRegistry;
    config: AgentConfig;
  }) {
    this.provider = options.provider;
    this.toolRegistry = options.toolRegistry;
    this.config = options.config;
    this.maxTurns = options.config.maxTurns ?? 25;
    this.conversation = new ConversationManager({
      systemPrompt: options.config.systemPrompt,
    });
  }

  async *run(userMessage: string): AsyncIterable<AgentEvent> {
    // Detect tool call mode on first run or after model change
    if (this.toolCallMode === null) {
      this.toolCallMode = await detectToolCallMode(this.config.model, this.config.baseUrl);
    }

    this.conversation.addUserMessage(userMessage);

    const tools = this.toolRegistry.getToolDefinitions();
    const isFallback = this.toolCallMode === ToolCallMode.FALLBACK;

    for (let turn = 1; turn <= this.maxTurns; turn++) {
      // Build system prompt — in fallback mode, append tool descriptions
      let systemPrompt = this.conversation.getSystemPrompt();
      if (isFallback && tools.length > 0) {
        systemPrompt += "\n\n" + buildFallbackToolPrompt(tools);
      }

      let accumulatedText = "";
      const pendingToolCalls: Array<{
        toolCallId: string;
        toolName: string;
        argsJson: string;
      }> = [];

      try {
        const stream = this.provider.chatStream({
          model: this.config.model,
          messages: this.conversation.buildMessageList(),
          systemPrompt,
          // Only pass tools in native mode
          tools: !isFallback && tools.length > 0 ? tools : undefined,
          temperature: this.config.temperature ?? 0.1,
          maxTokens: this.config.maxTokens,
        });

        for await (const chunk of stream) {
          const events = this.processChunk(chunk, pendingToolCalls);
          for (const event of events) {
            if (event.type === "text_delta") {
              accumulatedText += event.text;
            }
            yield event;
          }
        }
      } catch (err) {
        yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
        return;
      }

      // In fallback mode, parse <tool_call> blocks from the streamed text
      let fallbackToolCalls: ToolCallContent[] = [];
      let cleanText = accumulatedText;

      if (isFallback && accumulatedText) {
        const parsed = parseFallbackToolCalls(accumulatedText);
        fallbackToolCalls = parsed.toolCalls;
        cleanText = parsed.text;

        for (const err of parsed.errors) {
          yield { type: "warning", message: err };
        }
      }

      // Emit text_done with the clean text (tool_call blocks stripped in fallback mode)
      if (cleanText) {
        yield { type: "text_done", fullText: cleanText };
      }

      // Merge tool calls from both modes
      const allToolCalls = isFallback ? fallbackToolCalls : [];

      // Native mode: parse pending tool calls from stream chunks
      if (!isFallback) {
        for (const tc of pendingToolCalls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.argsJson || "{}");
          } catch {
            args = {};
            yield {
              type: "warning",
              message: `Failed to parse arguments for ${tc.toolName}: ${tc.argsJson}`,
            };
          }

          allToolCalls.push({
            type: "tool_call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            arguments: args,
          });

          yield {
            type: "tool_call_ready",
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            args,
          };
        }
      }

      // In fallback mode, emit tool_call events for the parsed calls
      if (isFallback) {
        for (const tc of fallbackToolCalls) {
          yield {
            type: "tool_call_ready",
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            args: tc.arguments,
          };
        }
      }

      // If no tool calls, we're done
      if (allToolCalls.length === 0) {
        this.conversation.addAssistantMessage(cleanText);
        yield { type: "turn_complete", turnNumber: turn };
        yield { type: "loop_complete", totalTurns: turn };
        return;
      }

      // Record assistant message
      if (isFallback) {
        // In fallback mode, store the raw text (with tool_call blocks) as the assistant message
        this.conversation.addAssistantMessage(accumulatedText);
      } else {
        this.conversation.addAssistantMessage(accumulatedText, allToolCalls);
      }

      // Execute each tool call
      const toolResults: Array<{ toolName: string; result: string; isError: boolean }> = [];

      for (const tc of allToolCalls) {
        const { result, isError } = await this.executeTool(tc);

        yield {
          type: "tool_result",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          result,
          isError,
        };

        toolResults.push({ toolName: tc.toolName, result, isError });

        if (!isFallback) {
          // Native mode: add tool results as tool messages
          this.conversation.addToolResult(tc.toolCallId, result, isError);
        }
      }

      // Fallback mode: inject tool results as a user message
      if (isFallback) {
        const resultMsg = buildFallbackToolResultMessage(toolResults);
        this.conversation.addUserMessage(resultMsg);
      }

      yield { type: "turn_complete", turnNumber: turn };
    }

    yield { type: "error", error: new MaxTurnsExceededError(this.maxTurns) };
  }

  setModel(model: string): void {
    this.config = { ...this.config, model };
    this.toolCallMode = null; // Re-detect on next run
  }

  getModel(): string {
    return this.config.model;
  }

  getProvider(): LLMProvider {
    return this.provider;
  }

  getBaseUrl(): string {
    return this.config.baseUrl;
  }

  getToolCallMode(): ToolCallMode | null {
    return this.toolCallMode;
  }

  reset(): void {
    this.conversation.clear();
  }

  getHistory() {
    return this.conversation.getHistory();
  }

  // -- Private --

  private processChunk(
    chunk: ChatStreamChunk,
    pendingToolCalls: Array<{ toolCallId: string; toolName: string; argsJson: string }>,
  ): AgentEvent[] {
    const events: AgentEvent[] = [];

    switch (chunk.type) {
      case "text_delta":
        if (chunk.text) {
          events.push({ type: "text_delta", text: chunk.text });
        }
        break;

      case "tool_call_start": {
        const tc = {
          toolCallId: chunk.toolCallId ?? `call_unknown_${Date.now()}`,
          toolName: chunk.toolName ?? "unknown",
          argsJson: "",
        };
        pendingToolCalls.push(tc);
        events.push({
          type: "tool_call_start",
          toolName: tc.toolName,
          toolCallId: tc.toolCallId,
        });
        break;
      }

      case "tool_call_delta": {
        const current = pendingToolCalls.find((tc) => tc.toolCallId === chunk.toolCallId);
        if (current && chunk.argumentsDelta) {
          current.argsJson += chunk.argumentsDelta;
          events.push({
            type: "tool_call_args_delta",
            toolCallId: current.toolCallId,
            delta: chunk.argumentsDelta,
          });
        }
        break;
      }

      case "tool_call_end":
        break;

      case "error":
        if (chunk.error) {
          events.push({ type: "error", error: chunk.error });
        }
        break;

      case "done":
        break;
    }

    return events;
  }

  private async executeTool(
    tc: ToolCallContent,
  ): Promise<{ result: string; isError: boolean }> {
    try {
      const toolResult = await this.toolRegistry.executeTool(tc.toolName, tc.arguments);
      return { result: toolResult.output, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: `Error: ${message}`, isError: true };
    }
  }
}
