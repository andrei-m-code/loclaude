export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolCallContent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  toolCallId: string;
  result: string;
  isError?: boolean;
}

export type MessageContent = TextContent | ToolCallContent | ToolResultContent;

export interface Message {
  role: MessageRole;
  content: MessageContent[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

export interface ChatResponse {
  message: Message;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: "stop" | "tool_calls" | "length" | "error";
  raw?: unknown;
}

export interface ChatStreamChunk {
  type:
    | "text_delta"
    | "tool_call_start"
    | "tool_call_delta"
    | "tool_call_end"
    | "done"
    | "error";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  argumentsDelta?: string;
  error?: Error;
  usage?: ChatResponse["usage"];
  finishReason?: ChatResponse["finishReason"];
}

export interface ModelInfo {
  id: string;
  name: string;
  size?: number;
  quantization?: string;
  modifiedAt?: Date;
}

export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  version?: string;
}

export interface LLMProvider {
  readonly name: string;
  readonly displayName: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk>;
  listModels(): Promise<ModelInfo[]>;
  healthCheck(): Promise<HealthCheckResult>;
}
