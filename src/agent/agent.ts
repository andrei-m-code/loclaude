import type { LLMProvider, ChatStreamChunk, ToolCallContent, Message, ToolDefinition } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ConversationManager } from "./conversation.js";
import { ToolCallMode, detectToolCallMode } from "../providers/tool-capability.js";
import {
  buildFallbackToolPrompt,
  parseFallbackToolCalls,
  buildFallbackToolResultMessage,
} from "../providers/tool-fallback.js";
import type { ExecutionPlan, PlanStep, StepResult, VerificationResult } from "./planner.js";
import {
  buildPlanningPrompt,
  buildStepExecutionPrompt,
  buildVerificationPrompt,
  parsePlan,
  parseVerification,
} from "./planner.js";

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
  | { type: "warning"; message: string }
  // 3-phase events
  | { type: "phase_start"; phase: "plan" | "execute" | "verify" }
  | { type: "phase_end"; phase: "plan" | "execute" | "verify" }
  | { type: "plan_ready"; plan: ExecutionPlan }
  | { type: "step_start"; stepNumber: number; totalSteps: number; description: string; tool: string }
  | { type: "step_end"; stepNumber: number; success: boolean }
  | { type: "verify_result"; result: VerificationResult };

// -- Agent Config --

export interface AgentConfig {
  model: string;
  systemPrompt: string;
  baseUrl: string;
  workingDirectory: string;
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
    const toolNames = this.toolRegistry.getToolNames();
    const isFallback = this.toolCallMode === ToolCallMode.FALLBACK;
    const workingDir = this.config.workingDirectory || process.cwd();

    // ── PHASE 1: PLAN ──
    yield { type: "phase_start", phase: "plan" };

    let plan: ExecutionPlan;
    try {
      plan = await this.generatePlan(userMessage, toolNames, workingDir, isFallback);
    } catch (err) {
      yield { type: "warning", message: `Planning failed, falling back to simple response: ${err instanceof Error ? err.message : String(err)}` };
      plan = {
        summary: "Respond to user request",
        steps: [{ stepNumber: 1, description: "Respond to the user", tool: "none", expectedOutcome: "Direct response" }],
        isSimpleQuestion: true,
      };
    }

    yield { type: "plan_ready", plan };
    yield { type: "phase_end", phase: "plan" };

    // ── SIMPLE QUESTION SHORT-CIRCUIT ──
    if (plan.isSimpleQuestion) {
      yield* this.runSimpleResponse(userMessage, isFallback);
      return;
    }

    // ── PHASE 2: EXECUTE ──
    yield { type: "phase_start", phase: "execute" };

    const stepResults: StepResult[] = [];

    for (const step of plan.steps) {
      yield {
        type: "step_start",
        stepNumber: step.stepNumber,
        totalSteps: plan.steps.length,
        description: step.description,
        tool: step.tool,
      };

      let stepResult: StepResult;
      try {
        stepResult = yield* this.executeStep(
          userMessage, plan, step, stepResults, tools, toolNames, isFallback, workingDir,
        );
      } catch (err) {
        stepResult = {
          stepNumber: step.stepNumber,
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
        yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
      }

      stepResults.push(stepResult);
      yield { type: "step_end", stepNumber: step.stepNumber, success: stepResult.success };
    }

    yield { type: "phase_end", phase: "execute" };

    // ── PHASE 3: VERIFY ──
    yield { type: "phase_start", phase: "verify" };

    let verification: VerificationResult;
    try {
      verification = await this.runVerification(userMessage, plan, stepResults, isFallback);
    } catch {
      verification = { status: "complete", summary: "Verification skipped due to error", issues: [] };
    }

    yield { type: "verify_result", result: verification };
    yield { type: "phase_end", phase: "verify" };

    // ── PERSIST ──
    const summary = this.buildConversationSummary(plan, stepResults, verification);
    this.conversation.addAssistantMessage(summary);

    yield { type: "loop_complete", totalTurns: plan.steps.length };
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

  // -- Private: Phase Implementations --

  private async generatePlan(
    userMessage: string,
    toolNames: string[],
    workingDir: string,
    isFallback: boolean,
  ): Promise<ExecutionPlan> {
    const planningPrompt = buildPlanningPrompt(userMessage, toolNames, workingDir);

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: planningPrompt }] },
    ];

    const systemPrompt = "You are a planning assistant. Output your plan as JSON inside <plan> tags. Do NOT execute any tools.";

    const response = await this.provider.chat({
      model: this.config.model,
      messages,
      systemPrompt,
      temperature: 0.1,
      maxTokens: this.config.maxTokens,
    });

    const rawText = response.message.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");

    return parsePlan(rawText, toolNames);
  }

  private async *executeStep(
    userMessage: string,
    plan: ExecutionPlan,
    currentStep: PlanStep,
    completedSteps: StepResult[],
    tools: ToolDefinition[],
    toolNames: string[],
    isFallback: boolean,
    workingDir: string,
  ): AsyncGenerator<AgentEvent, StepResult> {
    const stepPrompt = buildStepExecutionPrompt(
      userMessage, plan, currentStep, completedSteps, workingDir,
    );

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: stepPrompt }] },
    ];

    // Build system prompt for step execution
    let systemPrompt = this.conversation.getSystemPrompt();

    // In native mode, only pass the planned tool (if any) to restrict the model
    let stepTools: ToolDefinition[] | undefined;
    if (currentStep.tool !== "none") {
      if (isFallback) {
        // Append fallback tool prompt but only for the planned tool
        const plannedTool = tools.find((t) => t.name === currentStep.tool);
        if (plannedTool) {
          systemPrompt += "\n\n" + buildFallbackToolPrompt([plannedTool]);
        }
      } else {
        const plannedTool = tools.find((t) => t.name === currentStep.tool);
        stepTools = plannedTool ? [plannedTool] : undefined;
      }
    }

    let accumulatedText = "";
    const pendingToolCalls: Array<{
      toolCallId: string;
      toolName: string;
      argsJson: string;
    }> = [];

    const stream = this.provider.chatStream({
      model: this.config.model,
      messages,
      systemPrompt,
      tools: !isFallback ? stepTools : undefined,
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

    // In fallback mode, parse tool calls from text
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

    // Merge tool calls
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

    // Execute only the FIRST tool call (1 per step max)
    const result: StepResult = {
      stepNumber: currentStep.stepNumber,
      text: cleanText,
      success: true,
    };

    if (allToolCalls.length > 0) {
      const tc = allToolCalls[0];
      const { result: toolOutput, isError } = await this.executeTool(tc);

      yield {
        type: "tool_result",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        result: toolOutput,
        isError,
      };

      result.toolCall = { toolName: tc.toolName, toolCallId: tc.toolCallId, args: tc.arguments };
      result.toolResult = { output: toolOutput, isError };
      result.success = !isError;
    }

    return result;
  }

  private async *runSimpleResponse(
    userMessage: string,
    isFallback: boolean,
  ): AsyncIterable<AgentEvent> {
    // Stream a normal response using the full conversation history
    let systemPrompt = this.conversation.getSystemPrompt();
    const tools = this.toolRegistry.getToolDefinitions();

    if (isFallback && tools.length > 0) {
      systemPrompt += "\n\n" + buildFallbackToolPrompt(tools);
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

    // Handle fallback tool calls
    let cleanText = accumulatedText;
    if (isFallback && accumulatedText) {
      const parsed = parseFallbackToolCalls(accumulatedText);
      cleanText = parsed.text;
      for (const err of parsed.errors) {
        yield { type: "warning", message: err };
      }
    }

    if (cleanText) {
      yield { type: "text_done", fullText: cleanText };
    }

    this.conversation.addAssistantMessage(cleanText);
    yield { type: "loop_complete", totalTurns: 1 };
  }

  private async runVerification(
    userMessage: string,
    plan: ExecutionPlan,
    stepResults: StepResult[],
    isFallback: boolean,
  ): Promise<VerificationResult> {
    const verifyPrompt = buildVerificationPrompt(userMessage, plan, stepResults);

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: verifyPrompt }] },
    ];

    const systemPrompt = "You are a verification assistant. Evaluate whether the task was completed successfully. Output JSON inside <verify> tags.";

    const response = await this.provider.chat({
      model: this.config.model,
      messages,
      systemPrompt,
      temperature: 0.1,
      maxTokens: this.config.maxTokens,
    });

    const rawText = response.message.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");

    return parseVerification(rawText);
  }

  private buildConversationSummary(
    plan: ExecutionPlan,
    stepResults: StepResult[],
    verification: VerificationResult,
  ): string {
    const parts: string[] = [];

    parts.push(`Plan: ${plan.summary}`);

    for (const step of stepResults) {
      const status = step.success ? "OK" : "FAILED";
      let detail = step.text;
      if (step.toolResult) {
        detail = `[${step.toolCall?.toolName}] ${step.toolResult.output}`;
      }
      if (detail.length > 500) {
        detail = detail.slice(0, 500) + "...";
      }
      parts.push(`Step ${step.stepNumber} [${status}]: ${detail}`);
    }

    parts.push(`Verification: ${verification.status} — ${verification.summary}`);

    return parts.join("\n");
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
