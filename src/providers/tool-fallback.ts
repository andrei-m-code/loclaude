import type { ToolDefinition, ToolCallContent } from "./types.js";

export interface ParsedFallbackResponse {
  text: string;
  toolCalls: ToolCallContent[];
  errors: string[];
}

/**
 * Build a compact system prompt section that teaches the model to emit <tool_call> blocks.
 * References tool names from the system prompt — no duplicate schemas.
 */
export function buildFallbackToolPrompt(tools: ToolDefinition[]): string {
  const toolNames = tools.map((t) => t.name).join(", ");

  return `## Tool Calling

To use a tool, output a <tool_call> block with JSON:

<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1"}}
</tool_call>

Available tools: ${toolNames}
(See tool descriptions above for parameters.)

Rules:
- Valid JSON on a single line inside <tool_call> tags.
- You may call multiple tools using multiple <tool_call> blocks.
- After tool calls, STOP. Wait for results before continuing.
- Never fabricate tool results.

Examples:

User: "Read src/index.ts"
<tool_call>
{"name": "file_read", "arguments": {"file_path": "src/index.ts"}}
</tool_call>

User: "List all TypeScript files"
<tool_call>
{"name": "bash", "arguments": {"command": "find . -name '*.ts' -type f"}}
</tool_call>

User: "Find where getUserById is defined"
<tool_call>
{"name": "grep", "arguments": {"pattern": "function getUserById", "path": "src"}}
</tool_call>`;
}

/**
 * Parse <tool_call> blocks from the model's plain-text response.
 * Case-insensitive matching with alt-tag recovery.
 */
export function parseFallbackToolCalls(response: string): ParsedFallbackResponse {
  const toolCalls: ToolCallContent[] = [];
  const errors: string[] = [];
  let callIndex = 0;

  // Try multiple tag formats: <tool_call>, <toolcall>, <tool-call> (case-insensitive)
  const tagPatterns = [
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi,
    /<toolcall>\s*([\s\S]*?)\s*<\/toolcall>/gi,
    /<tool-call>\s*([\s\S]*?)\s*<\/tool-call>/gi,
  ];

  let cleanedResponse = response;
  let anyMatched = false;

  for (const regex of tagPatterns) {
    let match: RegExpExecArray | null;

    while ((match = regex.exec(response)) !== null) {
      anyMatched = true;
      const rawJson = match[1].trim();

      let parsed = tryParseToolCallJson(rawJson);

      if (!parsed) {
        // Try independent field extraction as last resort
        parsed = extractFieldsIndependently(rawJson);
      }

      if (!parsed) {
        errors.push(`Tool call #${callIndex}: invalid JSON — could not parse`);
        callIndex++;
        continue;
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
        arguments: parsed.arguments ?? {},
      });

      callIndex++;
    }

    // Remove matched tags from text
    cleanedResponse = cleanedResponse.replace(regex, "");

    // If we found matches with this pattern, don't try other patterns
    if (anyMatched) break;
  }

  // If no <tool_call> variants matched, try <function=name> format
  // e.g.: <function=bash><parameter=command>ls -la</parameter></function>
  if (!anyMatched) {
    const funcResult = parseFunctionTagCalls(response);
    if (funcResult.toolCalls.length > 0) {
      toolCalls.push(...funcResult.toolCalls);
      errors.push(...funcResult.errors);
      cleanedResponse = funcResult.text;
    }
  }

  const text = cleanedResponse.trim();

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
 * Attempt to parse JSON with common model mistake recovery.
 */
function tryParseToolCallJson(
  raw: string,
): { name: string; arguments: Record<string, unknown> } | null {
  // Try direct parse first
  try {
    const parsed = JSON.parse(raw) as { name?: string; arguments?: Record<string, unknown> };
    if (parsed.name) {
      return { name: parsed.name, arguments: parsed.arguments ?? {} };
    }
  } catch {
    // Continue to recovery
  }

  let fixed = raw;

  // Fix 1: Trailing commas
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");

  // Fix 2: Single quotes -> double quotes
  fixed = fixed.replace(/'/g, '"');

  // Fix 3: Unquoted keys
  fixed = fixed.replace(/(\{|,)\s*(\w+)\s*:/g, '$1"$2":');

  // Fix 4: Multi-line JSON -> single line
  fixed = fixed.replace(/\n\s*/g, " ");

  // Fix 5: Strip markdown code fences
  fixed = fixed.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");

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

/**
 * Parse <function=name><parameter=key>value</parameter></function> format.
 * Some Llama/Mistral models use this convention instead of <tool_call>.
 */
function parseFunctionTagCalls(response: string): ParsedFallbackResponse {
  const toolCalls: ToolCallContent[] = [];
  const errors: string[] = [];
  let callIndex = 0;

  // Match <function=toolname>...</function> blocks (case-insensitive)
  const funcRegex = /<function=(\w+)>([\s\S]*?)<\/function>/gi;
  let match: RegExpExecArray | null;

  while ((match = funcRegex.exec(response)) !== null) {
    const toolName = match[1];
    const body = match[2];

    // Extract <parameter=key>value</parameter> pairs from the body
    const args: Record<string, unknown> = {};
    const paramRegex = /<parameter=(\w+)>\s*([\s\S]*?)\s*<\/parameter>/gi;
    let paramMatch: RegExpExecArray | null;

    while ((paramMatch = paramRegex.exec(body)) !== null) {
      const key = paramMatch[1];
      const value = paramMatch[2].trim();

      // Try to parse as JSON (for numbers, booleans, objects, arrays)
      try {
        args[key] = JSON.parse(value);
      } catch {
        // Keep as string
        args[key] = value;
      }
    }

    if (!toolName) {
      errors.push(`Function call #${callIndex}: missing tool name`);
      callIndex++;
      continue;
    }

    toolCalls.push({
      type: "tool_call",
      toolCallId: `fallback_call_${Date.now()}_${callIndex}`,
      toolName,
      arguments: args,
    });

    callIndex++;
  }

  const text = response.replace(funcRegex, "").trim();

  return { text, toolCalls, errors };
}

/**
 * Last-resort extraction: pull "name" and "arguments" fields independently
 * when full JSON parse fails (e.g., model outputs malformed JSON).
 */
function extractFieldsIndependently(
  raw: string,
): { name: string; arguments: Record<string, unknown> } | null {
  // Extract name
  const nameMatch = raw.match(/"name"\s*:\s*"([^"]+)"/);
  if (!nameMatch) return null;

  const name = nameMatch[1];

  // Extract arguments object
  const argsMatch = raw.match(/"arguments"\s*:\s*(\{[\s\S]*\})/);
  if (argsMatch) {
    try {
      // Clean and try to parse arguments
      let argsStr = argsMatch[1];
      argsStr = argsStr.replace(/,\s*([}\]])/g, "$1");
      argsStr = argsStr.replace(/'/g, '"');
      const args = JSON.parse(argsStr) as Record<string, unknown>;
      return { name, arguments: args };
    } catch {
      // Return with empty args if we at least have the name
      return { name, arguments: {} };
    }
  }

  return { name, arguments: {} };
}
