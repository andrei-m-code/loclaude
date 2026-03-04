import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  Message,
  MessageContent,
  ToolDefinition,
  ModelInfo,
  HealthCheckResult,
  ToolCallContent,
} from "./types.js";
import { ProviderConnectionError, ProviderResponseError } from "../errors/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -- Anthropic API types --

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// -- Provider implementation --

export interface AnthropicProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
  maxRetries?: number;
}

/** Claude models available via the Anthropic API, ordered by capability. */
const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-20250514", name: "claude-opus-4-20250514" },
  { id: "claude-sonnet-4-20250514", name: "claude-sonnet-4-20250514" },
  { id: "claude-haiku-4-5-20251001", name: "claude-haiku-4-5-20251001" },
  { id: "claude-3-5-sonnet-20241022", name: "claude-3-5-sonnet-20241022" },
  { id: "claude-3-5-haiku-20241022", name: "claude-3-5-haiku-20241022" },
];

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly displayName = "Anthropic";

  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;
  private maxRetries: number;

  constructor(config: AnthropicProviderConfig) {
    this.baseUrl = (config.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel;
    this.maxRetries = config.maxRetries ?? 3;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildRequestBody(request, false);
    const response = await this.fetch("/v1/messages", body);
    const data = (await response.json()) as AnthropicResponse;
    return this.fromAnthropicResponse(data);
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const body = this.buildRequestBody(request, true);
    const response = await this.fetch("/v1/messages", body);

    if (!response.body) {
      throw new ProviderResponseError("Anthropic returned no response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Track tool_use blocks being streamed
    const pendingToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue; // skip comments/keepalives

          if (trimmed.startsWith("event: ")) {
            // We handle data lines, but track event type via the data payload
            continue;
          }

          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          yield* this.handleStreamEvent(event, pendingToolCalls, (u) => { usage = u; });
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
            yield* this.handleStreamEvent(event, pendingToolCalls, (u) => { usage = u; });
          } catch { /* skip */ }
        }
      }

      // Emit final done if not already emitted
      yield {
        type: "done",
        finishReason: pendingToolCalls.size > 0 ? "tool_calls" : "stop",
        usage,
      };
    } finally {
      reader.releaseLock();
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Anthropic doesn't have a public list-models endpoint that returns
    // available models for the account. Return the curated list.
    return [...ANTHROPIC_MODELS];
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      // Send a minimal request to verify the API key works
      const response = await globalThis.fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({
          model: this.defaultModel,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      const latencyMs = Date.now() - start;

      if (response.status === 401) {
        return { ok: false, latencyMs, error: "Invalid API key" };
      }
      // Any 2xx means the key works
      if (response.ok) {
        return { ok: true, latencyMs };
      }
      return { ok: false, latencyMs, error: `HTTP ${response.status}` };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // -- Private helpers --

  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  private buildRequestBody(
    request: ChatRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const { systemPrompt, messages } = this.toAnthropicMessages(request.messages, request.systemPrompt);

    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      stream,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.stop?.length) {
      body.stop_sequences = request.stop;
    }

    if (request.tools?.length) {
      body.tools = this.toAnthropicTools(request.tools);
    }

    return body;
  }

  private toAnthropicMessages(
    messages: Message[],
    systemPrompt?: string,
  ): { systemPrompt?: string; messages: AnthropicMessage[] } {
    const result: AnthropicMessage[] = [];
    let system = systemPrompt;

    for (const msg of messages) {
      if (msg.role === "system") {
        // Anthropic doesn't support system role in messages — prepend to system param
        const text = this.extractText(msg.content);
        system = system ? `${system}\n\n${text}` : text;
        continue;
      }

      if (msg.role === "user") {
        result.push({ role: "user", content: this.extractText(msg.content) });
        continue;
      }

      if (msg.role === "assistant") {
        const blocks: AnthropicContentBlock[] = [];
        const text = this.extractText(msg.content);
        if (text) {
          blocks.push({ type: "text", text });
        }
        const toolCalls = msg.content.filter(
          (c): c is ToolCallContent => c.type === "tool_call",
        );
        for (const tc of toolCalls) {
          blocks.push({
            type: "tool_use",
            id: tc.toolCallId,
            name: tc.toolName,
            input: tc.arguments,
          });
        }
        if (blocks.length > 0) {
          result.push({ role: "assistant", content: blocks });
        }
        continue;
      }

      if (msg.role === "tool") {
        // Anthropic expects tool_result blocks inside a user message
        const blocks: AnthropicContentBlock[] = [];
        for (const c of msg.content) {
          if (c.type === "tool_result") {
            blocks.push({
              type: "tool_result",
              tool_use_id: c.toolCallId,
              content: c.result,
              is_error: c.isError,
            });
          }
        }
        if (blocks.length > 0) {
          result.push({ role: "user", content: blocks });
        }
        continue;
      }
    }

    // Anthropic requires alternating user/assistant messages.
    // Merge consecutive same-role messages.
    const merged = this.mergeConsecutiveMessages(result);

    return { systemPrompt: system, messages: merged };
  }

  private mergeConsecutiveMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
    if (messages.length === 0) return [];

    const result: AnthropicMessage[] = [messages[0]];

    for (let i = 1; i < messages.length; i++) {
      const prev = result[result.length - 1];
      const curr = messages[i];

      if (prev.role === curr.role) {
        // Merge content
        const prevBlocks = typeof prev.content === "string"
          ? [{ type: "text" as const, text: prev.content }]
          : prev.content;
        const currBlocks = typeof curr.content === "string"
          ? [{ type: "text" as const, text: curr.content }]
          : curr.content;
        prev.content = [...prevBlocks, ...currBlocks];
      } else {
        result.push(curr);
      }
    }

    return result;
  }

  private toAnthropicTools(tools: ToolDefinition[]): AnthropicTool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  private fromAnthropicResponse(data: AnthropicResponse): ChatResponse {
    const content: MessageContent[] = [];

    for (const block of data.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_call",
          toolCallId: block.id,
          toolName: block.name,
          arguments: block.input,
        });
      }
    }

    const hasToolUse = data.content.some((b) => b.type === "tool_use");
    const finishReason = hasToolUse
      ? "tool_calls"
      : data.stop_reason === "max_tokens"
        ? "length"
        : "stop";

    return {
      message: { role: "assistant", content },
      usage: {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      },
      finishReason,
      raw: data,
    };
  }

  private *handleStreamEvent(
    event: Record<string, unknown>,
    pendingToolCalls: Map<number, { id: string; name: string; args: string }>,
    setUsage: (u: { promptTokens: number; completionTokens: number; totalTokens: number }) => void,
  ): Generator<ChatStreamChunk> {
    const eventType = event.type as string;

    switch (eventType) {
      case "message_start": {
        // Extract usage from message_start
        const message = event.message as { usage?: { input_tokens: number; output_tokens: number } } | undefined;
        if (message?.usage) {
          setUsage({
            promptTokens: message.usage.input_tokens,
            completionTokens: message.usage.output_tokens,
            totalTokens: message.usage.input_tokens + message.usage.output_tokens,
          });
        }
        break;
      }

      case "content_block_start": {
        const index = event.index as number;
        const contentBlock = event.content_block as { type: string; id?: string; name?: string; text?: string };

        if (contentBlock.type === "tool_use") {
          pendingToolCalls.set(index, {
            id: contentBlock.id ?? "",
            name: contentBlock.name ?? "",
            args: "",
          });
          yield {
            type: "tool_call_start",
            toolCallId: contentBlock.id,
            toolName: contentBlock.name,
          };
        }
        // text blocks start streaming via content_block_delta
        break;
      }

      case "content_block_delta": {
        const index = event.index as number;
        const delta = event.delta as { type: string; text?: string; partial_json?: string };

        if (delta.type === "text_delta" && delta.text) {
          yield { type: "text_delta", text: delta.text };
        } else if (delta.type === "input_json_delta" && delta.partial_json) {
          const pending = pendingToolCalls.get(index);
          if (pending) {
            pending.args += delta.partial_json;
            yield {
              type: "tool_call_delta",
              toolCallId: pending.id,
              argumentsDelta: delta.partial_json,
            };
          }
        }
        break;
      }

      case "content_block_stop": {
        const index = event.index as number;
        const pending = pendingToolCalls.get(index);
        if (pending) {
          yield { type: "tool_call_end", toolCallId: pending.id, toolName: pending.name };
        }
        break;
      }

      case "message_delta": {
        const delta = event.delta as { stop_reason?: string } | undefined;
        const msgUsage = event.usage as { output_tokens?: number } | undefined;
        if (msgUsage?.output_tokens !== undefined) {
          // Update completionTokens
          setUsage({
            promptTokens: 0, // Will be set from message_start
            completionTokens: msgUsage.output_tokens,
            totalTokens: msgUsage.output_tokens,
          });
        }
        if (delta?.stop_reason === "tool_use") {
          // Tool calls are done — the done event carries the finishReason
        }
        break;
      }

      case "message_stop": {
        // Final event — done is yielded after the loop
        break;
      }

      case "error": {
        const errorData = event.error as { message?: string } | undefined;
        yield {
          type: "error",
          error: new Error(errorData?.message ?? "Unknown Anthropic streaming error"),
        };
        break;
      }
    }
  }

  private extractText(content: MessageContent[]): string {
    return content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
  }

  private async fetch(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const maxRetries = this.maxRetries;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await globalThis.fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          if (response.status === 401) {
            throw new ProviderResponseError(
              "Invalid API key. Check your Anthropic API key.",
            );
          }
          if (response.status === 429) {
            if (attempt < maxRetries) {
              const retryAfter = response.headers.get("retry-after");
              const waitMs = retryAfter
                ? Math.min(parseFloat(retryAfter) * 1000, 30_000)
                : Math.min(1000 * 2 ** attempt, 15_000);
              await sleep(waitMs);
              continue;
            }
            throw new ProviderResponseError(
              "Rate limited by Anthropic after multiple retries. Please wait and try again.",
            );
          }
          if (response.status === 529) {
            // Anthropic overloaded
            if (attempt < maxRetries) {
              await sleep(Math.min(2000 * 2 ** attempt, 30_000));
              continue;
            }
            throw new ProviderResponseError(
              "Anthropic API is overloaded. Please try again later.",
            );
          }
          const text = await response.text().catch(() => "");
          throw new ProviderResponseError(`Anthropic returned HTTP ${response.status}: ${text}`);
        }

        return response;
      } catch (error) {
        if (error instanceof ProviderResponseError) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          await sleep(Math.min(1000 * 2 ** attempt, 15_000));
          continue;
        }
      }
    }

    throw new ProviderConnectionError(
      `Cannot connect to Anthropic at ${this.baseUrl}. Check your network connection.`,
      lastError,
    );
  }
}
