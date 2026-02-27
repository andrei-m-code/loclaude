import type { Message, MessageContent, ToolCallContent, ToolResultContent } from "../providers/types.js";

export class ConversationManager {
  private messages: Message[] = [];
  private systemPrompt: string;

  constructor(options: { systemPrompt: string }) {
    this.systemPrompt = options.systemPrompt;
  }

  addUserMessage(content: string): void {
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: content }],
    });
  }

  addAssistantMessage(content: string, toolCalls?: ToolCallContent[]): void {
    const msgContent: MessageContent[] = [];
    if (content) {
      msgContent.push({ type: "text", text: content });
    }
    if (toolCalls?.length) {
      msgContent.push(...toolCalls);
    }
    this.messages.push({ role: "assistant", content: msgContent });
  }

  addToolResult(toolCallId: string, result: string, isError?: boolean): void {
    const toolResult: ToolResultContent = {
      type: "tool_result",
      toolCallId,
      result,
      isError,
    };
    this.messages.push({ role: "tool", content: [toolResult] });
  }

  buildMessageList(): Message[] {
    return [...this.messages];
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  getHistory(): ReadonlyArray<Message> {
    return this.messages;
  }

  clear(): void {
    this.messages = [];
  }
}
