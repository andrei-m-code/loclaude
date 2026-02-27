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

// -- Ollama API types --

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagsResponse {
  models: Array<{
    name: string;
    size: number;
    details?: {
      quantization_level?: string;
    };
    modified_at?: string;
  }>;
}

// -- Provider implementation --

export interface OllamaProviderConfig {
  baseUrl: string;
  defaultModel: string;
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  readonly displayName = "Ollama (local)";

  private baseUrl: string;
  private defaultModel: string;
  private idCounter = 0;

  constructor(config: OllamaProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.defaultModel = config.defaultModel;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildRequestBody(request, false);

    const response = await this.fetch("/api/chat", body);
    const data = (await response.json()) as OllamaChatResponse;

    return this.fromOllamaResponse(data);
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const body = this.buildRequestBody(request, true);

    const response = await this.fetch("/api/chat", body);

    if (!response.body) {
      throw new ProviderResponseError("Ollama returned no response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Accumulate tool calls across chunks
    let pendingToolCalls: ToolCallContent[] = [];
    let accumulatedText = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          let chunk: OllamaChatResponse;
          try {
            chunk = JSON.parse(line) as OllamaChatResponse;
          } catch {
            continue; // skip malformed lines
          }

          // Handle text content
          if (chunk.message?.content) {
            accumulatedText += chunk.message.content;
            yield { type: "text_delta", text: chunk.message.content };
          }

          // Handle tool calls
          if (chunk.message?.tool_calls?.length) {
            for (const tc of chunk.message.tool_calls) {
              const toolCallId = this.generateToolCallId();
              const toolCall: ToolCallContent = {
                type: "tool_call",
                toolCallId,
                toolName: tc.function.name,
                arguments: tc.function.arguments,
              };
              pendingToolCalls.push(toolCall);

              yield {
                type: "tool_call_start",
                toolCallId,
                toolName: tc.function.name,
              };
              yield {
                type: "tool_call_delta",
                toolCallId,
                argumentsDelta: JSON.stringify(tc.function.arguments),
              };
              yield {
                type: "tool_call_end",
                toolCallId,
                toolName: tc.function.name,
              };
            }
          }

          // Final chunk
          if (chunk.done) {
            const finishReason = pendingToolCalls.length > 0 ? "tool_calls" : "stop";
            yield {
              type: "done",
              finishReason,
              usage: {
                promptTokens: chunk.prompt_eval_count ?? 0,
                completionTokens: chunk.eval_count ?? 0,
                totalTokens: (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0),
              },
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await globalThis.fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        throw new ProviderResponseError(`Ollama returned ${response.status} from /api/tags`);
      }
      const data = (await response.json()) as OllamaTagsResponse;
      return data.models.map((m) => ({
        id: m.name,
        name: m.name,
        size: m.size,
        quantization: m.details?.quantization_level,
        modifiedAt: m.modified_at ? new Date(m.modified_at) : undefined,
      }));
    } catch (error) {
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderConnectionError(
        `Cannot connect to Ollama at ${this.baseUrl}. Is Ollama running?`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const response = await globalThis.fetch(`${this.baseUrl}/api/tags`, {
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

  private buildRequestBody(
    request: ChatRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const messages = this.toOllamaMessages(request.messages, request.systemPrompt);

    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      messages,
      stream,
      options: {
        temperature: request.temperature,
        num_predict: request.maxTokens,
        stop: request.stop,
      },
    };

    if (request.tools?.length) {
      body.tools = this.toOllamaTools(request.tools);
    }

    return body;
  }

  private toOllamaMessages(messages: Message[], systemPrompt?: string): OllamaMessage[] {
    const result: OllamaMessage[] = [];

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
            function: {
              name: tc.toolName,
              arguments: tc.arguments,
            },
          }));

        const ollamaMsg: OllamaMessage = { role: "assistant", content: text };
        if (toolCalls.length > 0) {
          ollamaMsg.tool_calls = toolCalls;
        }
        result.push(ollamaMsg);
        continue;
      }

      if (msg.role === "tool") {
        const toolResult = msg.content.find((c) => c.type === "tool_result");
        if (toolResult && toolResult.type === "tool_result") {
          result.push({ role: "tool", content: toolResult.result });
        }
        continue;
      }
    }

    return result;
  }

  private toOllamaTools(tools: ToolDefinition[]): OllamaTool[] {
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  private fromOllamaResponse(data: OllamaChatResponse): ChatResponse {
    const content: MessageContent[] = [];

    if (data.message.content) {
      content.push({ type: "text", text: data.message.content });
    }

    if (data.message.tool_calls?.length) {
      for (const tc of data.message.tool_calls) {
        content.push({
          type: "tool_call",
          toolCallId: this.generateToolCallId(),
          toolName: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
    }

    const hasToolCalls = data.message.tool_calls && data.message.tool_calls.length > 0;
    const finishReason = hasToolCalls ? "tool_calls" : "stop";

    return {
      message: {
        role: "assistant",
        content,
      },
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
      finishReason,
      raw: data,
    };
  }

  private extractText(content: MessageContent[]): string {
    return content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
  }

  private generateToolCallId(): string {
    return `call_${Date.now()}_${++this.idCounter}`;
  }

  private async fetch(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    try {
      const response = await globalThis.fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (response.status === 404 && text.includes("not found")) {
          const model = (body.model as string) ?? "unknown";
          throw new ProviderResponseError(
            `Model '${model}' not found. Run \`ollama pull ${model}\` to download it.`,
          );
        }
        throw new ProviderResponseError(`Ollama returned HTTP ${response.status}: ${text}`);
      }

      return response;
    } catch (error) {
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderConnectionError(
        `Cannot connect to Ollama at ${this.baseUrl}. Is Ollama running?`,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
