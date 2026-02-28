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

// -- OpenAI API types --

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIChatResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: "stop" | "tool_calls" | "length" | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIStreamDelta {
  id: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: "stop" | "tool_calls" | "length" | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIModelsResponse {
  data: Array<{
    id: string;
    created: number;
    owned_by: string;
  }>;
}

// -- Provider implementation --

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
  maxRetries?: number;
}

/** Models known to work with /v1/chat/completions. Ordered by relevance. */
const CHAT_COMPLETIONS_MODELS = new Set([
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-4",
  "gpt-3.5-turbo",
  "chatgpt-4o-latest",
]);

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly displayName = "OpenAI";

  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;
  private maxRetries: number;

  constructor(config: OpenAIProviderConfig) {
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel;
    this.maxRetries = config.maxRetries ?? 3;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildRequestBody(request, false);
    const response = await this.fetch("/v1/chat/completions", body);
    const data = (await response.json()) as OpenAIChatResponse;
    return this.fromOpenAIResponse(data);
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const body = this.buildRequestBody(request, true);
    const response = await this.fetch("/v1/chat/completions", body);

    if (!response.body) {
      throw new ProviderResponseError("OpenAI returned no response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Track tool calls across stream deltas
    const pendingToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6); // strip "data: "
          if (data === "[DONE]") {
            // Emit done with usage if we have it
            yield {
              type: "done",
              finishReason: pendingToolCalls.size > 0 ? "tool_calls" : "stop",
            };
            continue;
          }

          let chunk: OpenAIStreamDelta;
          try {
            chunk = JSON.parse(data) as OpenAIStreamDelta;
          } catch {
            continue; // skip malformed
          }

          yield* this.handleStreamChunk(chunk, pendingToolCalls);
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const lines = buffer.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            yield {
              type: "done",
              finishReason: pendingToolCalls.size > 0 ? "tool_calls" : "stop",
            };
            continue;
          }
          try {
            const chunk = JSON.parse(data) as OpenAIStreamDelta;
            yield* this.handleStreamChunk(chunk, pendingToolCalls);
          } catch { /* skip malformed */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await globalThis.fetch(`${this.baseUrl}/v1/models`, {
        headers: this.getHeaders(),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new ProviderResponseError(`OpenAI returned ${response.status} from /v1/models: ${text}`);
      }
      const data = (await response.json()) as OpenAIModelsResponse;
      const available = new Set(data.data.map((m) => m.id));
      // Return curated models in relevance order, filtered to what the account has access to
      const order = [...CHAT_COMPLETIONS_MODELS];
      return order
        .filter((id) => available.has(id))
        .map((id) => ({ id, name: id }));
    } catch (error) {
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderConnectionError(
        `Cannot connect to OpenAI at ${this.baseUrl}. Check your API key and network.`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const response = await globalThis.fetch(`${this.baseUrl}/v1/models`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - start;
      if (!response.ok) {
        return { ok: false, latencyMs, error: `HTTP ${response.status}` };
      }
      return { ok: true, latencyMs };
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
      "Authorization": `Bearer ${this.apiKey}`,
    };
  }

  private buildRequestBody(
    request: ChatRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const messages = this.toOpenAIMessages(request.messages, request.systemPrompt);

    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      messages,
      stream,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stop: request.stop,
    };

    if (stream) {
      // Request usage in stream mode
      body.stream_options = { include_usage: true };
    }

    if (request.tools?.length) {
      body.tools = this.toOpenAITools(request.tools);
    }

    return body;
  }

  private toOpenAIMessages(messages: Message[], systemPrompt?: string): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    if (systemPrompt) {
      result.push({ role: "system", content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === "system") {
        result.push({ role: "system", content: this.extractText(msg.content) });
        continue;
      }

      if (msg.role === "user") {
        result.push({ role: "user", content: this.extractText(msg.content) });
        continue;
      }

      if (msg.role === "assistant") {
        const text = this.extractText(msg.content);
        const toolCalls = msg.content
          .filter((c): c is ToolCallContent => c.type === "tool_call")
          .map((tc) => ({
            id: tc.toolCallId,
            type: "function" as const,
            function: {
              name: tc.toolName,
              arguments: JSON.stringify(tc.arguments),
            },
          }));

        const openaiMsg: OpenAIMessage = { role: "assistant", content: text || null };
        if (toolCalls.length > 0) {
          openaiMsg.tool_calls = toolCalls;
        }
        result.push(openaiMsg);
        continue;
      }

      if (msg.role === "tool") {
        const toolResult = msg.content.find((c) => c.type === "tool_result");
        if (toolResult && toolResult.type === "tool_result") {
          result.push({
            role: "tool",
            content: toolResult.result,
            tool_call_id: toolResult.toolCallId,
          });
        }
        continue;
      }
    }

    return result;
  }

  private toOpenAITools(tools: ToolDefinition[]): OpenAITool[] {
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  private fromOpenAIResponse(data: OpenAIChatResponse): ChatResponse {
    const choice = data.choices[0];
    if (!choice) {
      throw new ProviderResponseError("OpenAI returned no choices");
    }

    const content: MessageContent[] = [];

    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }

    if (choice.message.tool_calls?.length) {
      for (const tc of choice.message.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }
        content.push({
          type: "tool_call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          arguments: args,
        });
      }
    }

    const hasToolCalls = choice.message.tool_calls && choice.message.tool_calls.length > 0;
    const finishReason = hasToolCalls ? "tool_calls" : (choice.finish_reason ?? "stop") as ChatResponse["finishReason"];

    return {
      message: {
        role: "assistant",
        content,
      },
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
      finishReason,
      raw: data,
    };
  }

  private *handleStreamChunk(
    chunk: OpenAIStreamDelta,
    pendingToolCalls: Map<number, { id: string; name: string; args: string }>,
  ): Generator<ChatStreamChunk> {
    const choice = chunk.choices?.[0];
    if (!choice) {
      // Final chunk may have usage but no choices
      if (chunk.usage) {
        yield {
          type: "done",
          finishReason: pendingToolCalls.size > 0 ? "tool_calls" : "stop",
          usage: {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          },
        };
      }
      return;
    }

    const delta = choice.delta;

    // Text content
    if (delta.content) {
      yield { type: "text_delta", text: delta.content };
    }

    // Tool calls (streamed incrementally)
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;

        if (tc.id) {
          // New tool call starting
          pendingToolCalls.set(idx, {
            id: tc.id,
            name: tc.function?.name ?? "",
            args: tc.function?.arguments ?? "",
          });
          yield {
            type: "tool_call_start",
            toolCallId: tc.id,
            toolName: tc.function?.name ?? "",
          };
        } else {
          // Continuation of existing tool call
          const existing = pendingToolCalls.get(idx);
          if (existing) {
            if (tc.function?.arguments) {
              existing.args += tc.function.arguments;
              yield {
                type: "tool_call_delta",
                toolCallId: existing.id,
                argumentsDelta: tc.function.arguments,
              };
            }
          }
        }
      }
    }

    // Finish reason
    if (choice.finish_reason === "tool_calls") {
      // Emit tool_call_end for each pending tool call
      for (const [, tc] of pendingToolCalls) {
        yield { type: "tool_call_end", toolCallId: tc.id, toolName: tc.name };
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
              "Invalid API key. Check your OpenAI API key.",
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
              "Rate limited by OpenAI after multiple retries. Please wait and try again.",
            );
          }
          const text = await response.text().catch(() => "");
          throw new ProviderResponseError(`OpenAI returned HTTP ${response.status}: ${text}`);
        }

        return response;
      } catch (error) {
        if (error instanceof ProviderResponseError) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        // Network errors: retry with backoff
        if (attempt < maxRetries) {
          await sleep(Math.min(1000 * 2 ** attempt, 15_000));
          continue;
        }
      }
    }

    throw new ProviderConnectionError(
      `Cannot connect to OpenAI at ${this.baseUrl}. Check your network connection.`,
      lastError,
    );
  }
}
