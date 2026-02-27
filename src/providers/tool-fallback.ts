import type { ToolDefinition, ToolCallContent } from "./types.js";

export interface ParsedFallbackResponse {
  text: string;
  toolCalls: ToolCallContent[];
  errors: string[];
}

/**
 * Build system prompt section that teaches the model to emit <tool_call> blocks.
 */
export function buildFallbackToolPrompt(tools: ToolDefinition[]): string {
  let prompt = `## Tool Calling

You have access to tools. To call a tool, output a tool_call block EXACTLY like this:

<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}
</tool_call>

RULES:
- The JSON inside <tool_call> must be valid JSON on a SINGLE LINE.
- You may call multiple tools in one response using multiple <tool_call> blocks.
- You may include explanation text before and between tool calls.
- After you output tool calls, STOP. Do not guess the results.
- You will receive the actual results in the next message and can then continue.
- NEVER fabricate or imagine tool results.

## Available Tools

`;

  for (const tool of tools) {
    prompt += `### ${tool.name}\n`;
    prompt += `${tool.description}\n`;
    prompt += `Parameters:\n`;
    prompt += "```json\n" + JSON.stringify(tool.parameters, null, 2) + "\n```\n\n";
  }

  prompt +=
    '## Example\n\n' +
    'User: "Read the file src/index.ts"\n\n' +
    "Assistant: I'll read that file for you.\n\n" +
    "<tool_call>\n" +
    '{"name": "file_read", "arguments": {"file_path": "src/index.ts"}}\n' +
    "</tool_call>";

  return prompt;
}

/**
 * Parse <tool_call> blocks from the model's plain-text response.
 */
export function parseFallbackToolCalls(response: string): ParsedFallbackResponse {
  const toolCalls: ToolCallContent[] = [];
  const errors: string[] = [];
  let callIndex = 0;

  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match: RegExpExecArray | null;

  while ((match = toolCallRegex.exec(response)) !== null) {
    const rawJson = match[1].trim();

    let parsed: { name?: string; arguments?: Record<string, unknown> } | null = null;

    try {
      parsed = JSON.parse(rawJson) as { name?: string; arguments?: Record<string, unknown> };
    } catch (err) {
      // Attempt recovery
      parsed = attemptJsonRecovery(rawJson);
      if (!parsed) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Tool call #${callIndex}: invalid JSON — ${msg}`);
        callIndex++;
        continue;
      }
    }

    if (!parsed.name || typeof parsed.name !== "string") {
      errors.push(`Tool call #${callIndex}: missing or invalid "name" field`);
      callIndex++;
      continue;
    }

    toolCalls.push({
      type: "tool_call",
      toolCallId: `fallback_call_${Date.now()}_${callIndex}`,
      toolName: parsed.name,
      arguments: (parsed.arguments as Record<string, unknown>) ?? {},
    });

    callIndex++;
  }

  // Remove tool_call blocks from text to get the "content" portion
  const text = response.replace(toolCallRegex, "").trim();

  return { text, toolCalls, errors };
}

/**
 * Build a user message containing tool results for fallback mode.
 * (Non-tool-calling models don't understand role:"tool", so we use role:"user".)
 */
export function buildFallbackToolResultMessage(
  results: Array<{ toolName: string; result: string; isError: boolean }>,
): string {
  let content = "Tool results:\n\n";

  for (const r of results) {
    content += `<tool_result name="${r.toolName}"${r.isError ? ' error="true"' : ""}>\n`;
    content += r.result;
    content += "\n</tool_result>\n\n";
  }

  content +=
    "Continue based on these results. If you need to call more tools, use <tool_call> blocks. Otherwise, respond to the user.";

  return content;
}

/**
 * Attempt to fix common JSON mistakes from models.
 */
function attemptJsonRecovery(
  raw: string,
): { name: string; arguments: Record<string, unknown> } | null {
  let fixed = raw;

  // Fix 1: Trailing commas
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");

  // Fix 2: Single quotes → double quotes
  fixed = fixed.replace(/'/g, '"');

  // Fix 3: Unquoted keys
  fixed = fixed.replace(/(\{|,)\s*(\w+)\s*:/g, '$1"$2":');

  // Fix 4: Multi-line JSON → single line
  fixed = fixed.replace(/\n\s*/g, " ");

  try {
    const result = JSON.parse(fixed) as { name?: string; arguments?: Record<string, unknown> };
    if (result.name && typeof result.name === "string") {
      return { name: result.name, arguments: result.arguments ?? {} };
    }
    return null;
  } catch {
    return null;
  }
}
