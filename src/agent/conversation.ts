import type { Message, MessageContent, ToolCallContent, ToolResultContent } from "../providers/types.js";

export interface ConversationOptions {
  systemPrompt: string;
  /** Max chars for conversation context (default: 24000 ~= 6K tokens). */
  maxContextChars?: number;
  /** Max chars per tool result before truncation (default: 1500). */
  maxToolResultLength?: number;
}

export class ConversationManager {
  private messages: Message[] = [];
  private systemPrompt: string;
  private maxContextChars: number;
  private maxToolResultLength: number;

  constructor(options: ConversationOptions) {
    this.systemPrompt = options.systemPrompt;
    this.maxContextChars = options.maxContextChars ?? 24_000;
    this.maxToolResultLength = options.maxToolResultLength ?? 1500;
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
    // Truncate long tool results to save context space
    const truncatedResult = result.length > this.maxToolResultLength
      ? result.slice(0, this.maxToolResultLength) + "\n... (truncated)"
      : result;

    const toolResult: ToolResultContent = {
      type: "tool_result",
      toolCallId,
      result: truncatedResult,
      isError,
    };
    this.messages.push({ role: "tool", content: [toolResult] });
  }

  /**
   * Build a message list that fits within the context budget.
   *
   * Strategy: walk backward from the most recent message, grouping
   * assistant+tool messages as atomic units (never split tool_call from
   * its tool_result). Include as many groups as fit within maxContextChars.
   * Always include the most recent user message.
   */
  buildMessageList(): Message[] {
    if (this.messages.length === 0) return [];

    const budget = this.maxContextChars;

    // Group messages into atomic units that shouldn't be split.
    // A group is either:
    //   - A user message (standalone)
    //   - An assistant message + following tool messages (atomic pair)
    const groups: Message[][] = [];
    let i = 0;
    while (i < this.messages.length) {
      const msg = this.messages[i];
      if (msg.role === "assistant") {
        // Collect this assistant msg + any following tool msgs
        const group: Message[] = [msg];
        let j = i + 1;
        while (j < this.messages.length && this.messages[j].role === "tool") {
          group.push(this.messages[j]);
          j++;
        }
        groups.push(group);
        i = j;
      } else {
        groups.push([msg]);
        i++;
      }
    }

    // Walk backward, accumulating groups until budget is exceeded
    let totalChars = 0;
    let startGroupIdx = groups.length;

    for (let g = groups.length - 1; g >= 0; g--) {
      const groupChars = this.estimateGroupChars(groups[g]);
      if (totalChars + groupChars > budget && g < groups.length - 1) {
        // Adding this group would exceed budget, stop here
        break;
      }
      totalChars += groupChars;
      startGroupIdx = g;
    }

    // Flatten selected groups into messages
    const result: Message[] = [];
    for (let g = startGroupIdx; g < groups.length; g++) {
      result.push(...groups[g]);
    }

    // Ensure the list starts with a user message (LLM APIs require this)
    if (result.length > 0 && result[0].role !== "user") {
      // Prepend a context note so the model knows history was truncated
      result.unshift({
        role: "user",
        content: [{ type: "text", text: "[Earlier conversation history was truncated to fit context window.]" }],
      });
    }

    return result;
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

  private estimateGroupChars(group: Message[]): number {
    let chars = 0;
    for (const msg of group) {
      for (const content of msg.content) {
        if (content.type === "text") {
          chars += content.text.length;
        } else if (content.type === "tool_call") {
          chars += content.toolName.length + JSON.stringify(content.arguments).length + 20;
        } else if (content.type === "tool_result") {
          chars += content.result.length + 20;
        }
      }
      // Role overhead
      chars += 10;
    }
    return chars;
  }
}
