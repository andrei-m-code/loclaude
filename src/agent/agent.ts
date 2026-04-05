import type { LLMProvider, ChatStreamChunk, ToolCallContent } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ConversationManager } from "./conversation.js";
import { ToolCallMode, detectToolCallMode } from "../providers/tool-capability.js";
import {
  buildFallbackToolPrompt,
  parseFallbackToolCalls,
  buildFallbackToolResultMessage,
} from "../providers/tool-fallback.js";
import { buildPlanningPrompt } from "./system-prompt.js";

// -- Plan Types (used by fallback models) --

export interface PlanStep {
  number: number;
  description: string;
  tool: string; // parsed from [tool_name] suffix, or "none"
}

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
  | { type: "plan_ready"; steps: PlanStep[] }
  | { type: "step_start"; stepNumber: number; totalSteps: number; description: string }
  | { type: "step_end"; stepNumber: number; success: boolean }
  | { type: "error"; error: Error }
  | { type: "warning"; message: string }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number };

// -- Agent Config --

export interface AgentConfig {
  model: string;
  systemPrompt: string;
  baseUrl: string;
  workingDirectory: string;
  workspaceContext?: string;
  temperature?: number;
  maxTokens?: number;
  maxTurns?: number;
  maxContextChars?: number;
  maxToolResultLength?: number;
  contextWindow?: number;
}

// -- Agent --

// -- Tool History Entry --

interface ToolHistoryEntry {
  tool: string;
  summary: string;
  isError: boolean;
}

export class Agent {
  private provider: LLMProvider;
  private toolRegistry: ToolRegistry;
  private conversation: ConversationManager;
  private config: AgentConfig;
  private maxTurns: number;
  private toolCallMode: ToolCallMode | null = null;
  private currentUserRequest = "";
  private toolHistory: ToolHistoryEntry[] = [];

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
      maxContextChars: options.config.maxContextChars,
      maxToolResultLength: options.config.maxToolResultLength,
    });
  }

  async *run(userMessage: string): AsyncIterable<AgentEvent> {
    if (this.toolCallMode === null) {
      this.toolCallMode = await detectToolCallMode(this.config.model, this.config.baseUrl);
    }

    this.currentUserRequest = userMessage;
    this.toolHistory = [];
    this.conversation.addUserMessage(userMessage);
    const isFallback = this.toolCallMode === ToolCallMode.FALLBACK;

    if (isFallback || this.needsPlanning(userMessage)) {
      // Complex tasks and fallback models benefit from structured
      // plan → execute flow to stay on track.
      yield* this.runWithPlan(isFallback);
    } else {
      // Simple tasks with native tool-calling models go straight to the
      // tool loop — no planning overhead.
      yield* this.runToolLoop(false);
    }
  }

  /**
   * Decide whether a task needs planning based on the user message.
   * Complex tasks (multi-file creation, project scaffolding, multi-step work)
   * benefit from a plan. Simple tasks (questions, single file ops) don't.
   */
  private needsPlanning(message: string): boolean {
    const lower = message.toLowerCase();
    let score = 0;

    // Long messages usually describe complex tasks
    if (message.length > 250) score++;

    // Project/app creation
    if (/\b(create|build|implement|scaffold|set\s*up|generate|bootstrap)\b/.test(lower) &&
        /\b(api|app|project|service|server|application|site|website|library)\b/.test(lower)) {
      score += 2;
    }

    // Multiple requirements joined together
    const withAndCount = (lower.match(/\bwith\b/g) || []).length + (lower.match(/\band\b/g) || []).length;
    if (withAndCount >= 2) score++;

    // Multiple technologies/frameworks mentioned
    const techTerms = [
      "authentication", "authorization", "entity framework", "database", "docker",
      "testing", "middleware", "swagger", "migration", "dependency injection",
      "logging", "caching", "validation", "cors", "jwt", "oauth",
      "react", "angular", "vue", "express", "fastapi", "django", "flask",
      "redis", "postgres", "mongodb", "sqlite", "mysql",
    ];
    const techCount = techTerms.filter(t => lower.includes(t)).length;
    if (techCount >= 2) score++;

    // Explicit multi-step language
    if (/\b(then|after that|also|next|finally|first|second)\b/.test(lower)) score++;

    // Refactoring / migration (always complex)
    if (/\b(refactor|migrate|convert|rewrite|restructure|reorganize)\b/.test(lower)) score++;

    return score >= 2;
  }

  /**
   * Plan → execute flow.
   * Phase 1: LLM call without tools to get a plan or direct answer.
   * Phase 2: Execute each plan step with tools.
   */
  private async *runWithPlan(isFallback: boolean): AsyncIterable<AgentEvent> {
    const planningPrompt = buildPlanningPrompt({
      tools: this.toolRegistry.getToolDefinitions(),
      workingDirectory: this.config.workingDirectory,
      workspaceContext: this.config.workspaceContext,
    });

    let planText = "";
    const stream = this.provider.chatStream({
      model: this.config.model,
      messages: this.conversation.buildMessageList(),
      systemPrompt: planningPrompt,
      temperature: this.config.temperature ?? 0.1,
      maxTokens: this.config.maxTokens,
      contextWindow: this.config.contextWindow,
    });

    for await (const chunk of stream) {
      if (chunk.type === "text_delta" && chunk.text) {
        planText += chunk.text;
        yield { type: "text_delta", text: chunk.text };
      }
      if (chunk.type === "done" && chunk.usage) {
        yield { type: "usage", promptTokens: chunk.usage.promptTokens, completionTokens: chunk.usage.completionTokens, totalTokens: chunk.usage.totalTokens };
      }
    }

    // Fallback models may skip the plan and emit <tool_call> tags directly.
    if (isFallback) {
      const parsed = parseFallbackToolCalls(planText);
      if (parsed.toolCalls.length > 0) {
        yield { type: "text_done", fullText: parsed.text };
        this.conversation.addAssistantMessage(parsed.text, parsed.toolCalls);

        for (const err of parsed.errors) {
          yield { type: "warning", message: err };
        }

        const toolResults: Array<{ toolName: string; result: string; isError: boolean }> = [];
        for (const tc of parsed.toolCalls) {
          yield { type: "tool_call_ready", toolName: tc.toolName, toolCallId: tc.toolCallId, args: tc.arguments };
          const { result, isError } = await this.executeTool(tc);
          yield { type: "tool_result", toolCallId: tc.toolCallId, toolName: tc.toolName, result, isError };
          toolResults.push({ toolName: tc.toolName, result, isError });
        }

        for (const tr of toolResults) {
          this.toolHistory.push({
            tool: tr.toolName,
            summary: tr.isError ? `ERROR: ${tr.result.slice(0, 80)}` : `OK (${tr.result.length} chars)`,
            isError: tr.isError,
          });
        }

        const resultContent = buildFallbackToolResultMessage(toolResults, this.currentUserRequest);
        this.conversation.addUserMessage(resultContent);

        yield* this.runToolLoop(true);
        yield { type: "loop_complete", totalTurns: 1 };
        return;
      }
    }

    yield { type: "text_done", fullText: planText };
    this.conversation.addAssistantMessage(planText);

    const steps = parsePlanSteps(planText);

    if (steps.length === 0) {
      yield { type: "loop_complete", totalTurns: 1 };
      return;
    }

    yield { type: "plan_ready", steps };

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      yield { type: "step_start", stepNumber: i + 1, totalSteps: steps.length, description: step.description };

      this.conversation.addUserMessage(`Execute step ${i + 1}: ${step.description}`);
      yield* this.runToolLoop(isFallback, 5);

      yield { type: "step_end", stepNumber: i + 1, success: true };
    }

    yield { type: "loop_complete", totalTurns: steps.length + 1 };
  }

  setProvider(provider: LLMProvider, baseUrl: string): void {
    this.provider = provider;
    this.config = { ...this.config, baseUrl };
    this.toolCallMode = null; // Re-detect on next run
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

  getCurrentDir(): string {
    const bash = this.toolRegistry.getTool("bash");
    if (bash && typeof (bash as unknown as { getCurrentDir?: unknown }).getCurrentDir === "function") {
      return (bash as unknown as { getCurrentDir(): string }).getCurrentDir();
    }
    return this.config.workingDirectory;
  }

  reset(): void {
    this.conversation.clear();
    this.currentUserRequest = "";
    this.toolHistory = [];
  }

  getHistory() {
    return this.conversation.getHistory();
  }

  getToolNames(): string[] {
    return this.toolRegistry.getToolNames();
  }

  // -- Private: Tool Loop --

  /**
   * Core agent loop — streams response and loops on tool calls.
   * Handles both native and fallback tool calling modes.
   */
  private async *runToolLoop(isFallback: boolean, maxTurnsOverride?: number): AsyncIterable<AgentEvent> {
    const maxTurns = maxTurnsOverride ?? this.maxTurns;
    const baseSystemPrompt = this.conversation.getSystemPrompt();
    const tools = this.toolRegistry.getToolDefinitions();

    for (let turn = 1; turn <= maxTurns; turn++) {
      // Build system prompt with context block for this turn
      let systemPrompt = baseSystemPrompt;

      if (isFallback && tools.length > 0) {
        systemPrompt += "\n\n" + buildFallbackToolPrompt(tools);
      }

      // Add running context / scratchpad
      if (this.toolHistory.length > 0 || this.currentUserRequest) {
        systemPrompt += "\n\n" + this.buildContextBlock();
      }
      let accumulatedText = "";
      const pendingToolCalls: Array<{
        toolCallId: string;
        toolName: string;
        argsJson: string;
      }> = [];

      const stream = this.provider.chatStream({
        model: this.config.model,
        messages: this.conversation.buildMessageList(),
        systemPrompt,
        tools: !isFallback && tools.length > 0 ? tools : undefined,
        temperature: this.config.temperature ?? 0.1,
        maxTokens: this.config.maxTokens,
        contextWindow: this.config.contextWindow,
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

      // Parse fallback tool calls from text if needed
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

      if (cleanText) {
        yield { type: "text_done", fullText: cleanText };
      }

      // Merge native + fallback tool calls
      const allToolCalls: ToolCallContent[] = isFallback ? [...fallbackToolCalls] : [];

      if (!isFallback) {
        for (const tc of pendingToolCalls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.argsJson || "{}");
          } catch {
            args = {};
            yield { type: "warning", message: `Failed to parse arguments for ${tc.toolName}: ${tc.argsJson}` };
          }
          allToolCalls.push({
            type: "tool_call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            arguments: args,
          });
          yield { type: "tool_call_ready", toolName: tc.toolName, toolCallId: tc.toolCallId, args };
        }
      }

      if (isFallback) {
        for (const tc of fallbackToolCalls) {
          yield { type: "tool_call_ready", toolName: tc.toolName, toolCallId: tc.toolCallId, args: tc.arguments };
        }
      }

      // No tool calls -> done
      if (allToolCalls.length === 0) {
        this.conversation.addAssistantMessage(cleanText);
        yield { type: "loop_complete", totalTurns: turn };
        return;
      }

      // Execute tool calls and add results to conversation
      this.conversation.addAssistantMessage(cleanText, allToolCalls);

      const toolResults: Array<{ toolName: string; result: string; isError: boolean }> = [];

      for (const tc of allToolCalls) {
        const { result: toolOutput, isError } = await this.executeTool(tc);

        // Track in tool history
        this.toolHistory.push({
          tool: tc.toolName,
          summary: isError ? `ERROR: ${toolOutput.slice(0, 80)}` : `OK (${toolOutput.length} chars)`,
          isError,
        });

        yield {
          type: "tool_result",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          result: toolOutput,
          isError,
        };

        if (isFallback) {
          toolResults.push({ toolName: tc.toolName, result: toolOutput, isError });
        } else {
          this.conversation.addToolResult(tc.toolCallId, toolOutput, isError);
        }
      }

      if (isFallback && toolResults.length > 0) {
        const resultContent = buildFallbackToolResultMessage(toolResults, this.currentUserRequest);
        this.conversation.addUserMessage(resultContent);
      }

      yield { type: "turn_complete", turnNumber: turn };
    }

    yield { type: "warning", message: `Reached maximum turns (${maxTurns})` };
    yield { type: "loop_complete", totalTurns: maxTurns };
  }

  // -- Private: Chunk Processing --

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
        if (chunk.usage) {
          events.push({
            type: "usage",
            promptTokens: chunk.usage.promptTokens,
            completionTokens: chunk.usage.completionTokens,
            totalTokens: chunk.usage.totalTokens,
          });
        }
        break;
    }

    return events;
  }

  private async executeTool(
    tc: ToolCallContent,
  ): Promise<{ result: string; isError: boolean }> {
    try {
      const toolResult = await this.toolRegistry.executeTool(tc.toolName, tc.arguments);
      const output = this.addBashFailureGuidance(tc.toolName, toolResult.output);
      return { result: output, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const guidance = this.getErrorGuidance(tc.toolName, message);
      return { result: `Error: ${message}${guidance}`, isError: true };
    }
  }

  private getErrorGuidance(toolName: string, error: string): string {
    const hints: string[] = [];

    if (error.includes("ENOENT") || error.includes("not found") || error.includes("No such file")) {
      hints.push("The file/path does not exist. Use `glob` to search for files or `list_directory` to browse.");
    }

    if (error.includes("EACCES") || error.includes("permission denied")) {
      hints.push("Permission denied. Try a different path or check file permissions.");
    }

    if (error.includes("Unknown tool") || error.includes("not registered")) {
      hints.push("That tool does not exist. Check the available tools list in the system prompt.");
    }

    if (error.includes("validation") || error.includes("required")) {
      hints.push("Check the tool's required parameters. Re-read the tool description for correct argument names.");
    }

    if (error.includes("ENOTEMPTY") || error.includes("not empty") || error.includes("Directory not empty")) {
      hints.push("Directory is not empty. Use bash with `rm -rf dirname/` to remove non-empty directories.");
    }

    if (hints.length === 0) return "";
    return "\n\nHINT: " + hints.join(" ");
  }

  /**
   * Post-process successful tool results to add guidance when bash commands
   * fail (non-zero exit code) but don't throw exceptions.
   */
  private addBashFailureGuidance(toolName: string, result: string): string {
    if (toolName !== "bash") return result;

    // Check for non-zero exit code
    const exitMatch = result.match(/\[Exit code: (\d+)\]/);
    if (!exitMatch || exitMatch[1] === "0") return result;

    const hints: string[] = [];

    if (result.includes("No such file or directory")) {
      hints.push("Path does not exist. Use `glob` or `list_directory` to find the correct path.");
    }
    if (result.includes("rmdir") && result.includes("not empty")) {
      hints.push("Use `rm -rf dirname/` instead of `rmdir` for non-empty directories.");
    }
    if (result.includes("command not found")) {
      hints.push("Command not installed. Check if the command name is correct or install it first.");
    }
    if (result.includes("Permission denied")) {
      hints.push("Permission denied. Check the file path and permissions.");
    }

    if (hints.length > 0) {
      return result + "\n\nHINT: " + hints.join(" ") + " Do NOT retry the same command — fix the issue first.";
    }

    return result + "\n\nThe command failed. Read the error output above carefully. Do NOT retry the same command — try a different approach.";
  }

  private buildContextBlock(): string {
    let block = "[Context]\n";
    block += `User request: ${this.currentUserRequest}\n`;

    if (this.toolHistory.length > 0) {
      block += "Tool calls so far:\n";
      for (const entry of this.toolHistory.slice(-10)) { // last 10 calls
        const status = entry.isError ? "FAILED" : "OK";
        block += `  - ${entry.tool}: ${status} — ${entry.summary}\n`;
      }
    }

    block += "Next: Call a tool to make progress, or respond to the user if the task is complete.";
    return block;
  }
}

// -- Plan Step Parser (used by fallback models) --

/**
 * Parse numbered plan steps from the model's text response.
 * Matches lines like "1. Some description [tool_name]" or "1. Some description".
 */
function parsePlanSteps(text: string): PlanStep[] {
  const steps: PlanStep[] = [];
  const stepRegex = /^\s*(\d+)\.\s+(.+?)(?:\s*\[(\w+)\])?\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = stepRegex.exec(text)) !== null) {
    steps.push({
      number: parseInt(match[1], 10),
      description: match[2].trim(),
      tool: match[3]?.toLowerCase() ?? "none",
    });
  }

  if (steps.length === 1 && steps[0].tool === "none") {
    return [];
  }

  return steps.slice(0, 10);
}
