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
  // Build per-tool parameter reference so the model knows exact param names
  const toolRef = tools.map(t => {
    const params = t.parameters as {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    const paramList = params.properties
      ? Object.entries(params.properties).map(([k, v]) => `${k}: ${v.type ?? "string"}`).join(", ")
      : "";
    return `- **${t.name}**(${paramList}): ${t.description}`;
  }).join("\n");

  return `## How to Call Tools

**YOU MUST USE THIS EXACT FORMAT to call tools. Do NOT use any other format.**

<tool_call>
{"name": "TOOL_NAME", "arguments": {"param": "value"}}
</tool_call>

This is the ONLY way to call tools. Do NOT put tool calls in code blocks. Do NOT write JSON without the <tool_call> tags.

## Available Tools

${toolRef}

## Examples

User: "Read src/index.ts"

<tool_call>
{"name": "file_read", "arguments": {"file_path": "src/index.ts"}}
</tool_call>

User: "Create a hello.py file"

<tool_call>
{"name": "file_write", "arguments": {"file_path": "hello.py", "content": "print('hello world')\\n"}}
</tool_call>

User: "Run the tests"

<tool_call>
{"name": "bash", "arguments": {"command": "npm test"}}
</tool_call>

User: "Find all Python files"

<tool_call>
{"name": "glob", "arguments": {"pattern": "**/*.py"}}
</tool_call>

User: "Search for the login function"

<tool_call>
{"name": "grep", "arguments": {"pattern": "function login", "path": "src"}}
</tool_call>

## Rules
- Always wrap tool calls in <tool_call> and </tool_call> tags
- JSON must have "name" (string) and "arguments" (object) fields
- After calling tools, STOP and wait for results
- Never fabricate tool results — wait for the actual output`;
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
      anyMatched = true;
      toolCalls.push(...funcResult.toolCalls);
      errors.push(...funcResult.errors);
      cleanedResponse = funcResult.text;
    }
  }

  // If still no matches, try JSON tool calls in markdown code blocks
  // e.g.: ```json\n{"name": "file_read", "arguments": {...}}\n```
  if (!anyMatched) {
    const codeBlockResult = parseCodeBlockToolCalls(response);
    if (codeBlockResult.toolCalls.length > 0) {
      toolCalls.push(...codeBlockResult.toolCalls);
      errors.push(...codeBlockResult.errors);
      cleanedResponse = codeBlockResult.text;
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
 * Parse tool calls from markdown code blocks (```json ... ```).
 * Some models output tool calls as JSON in code fences instead of <tool_call> tags.
 */
function parseCodeBlockToolCalls(response: string): ParsedFallbackResponse {
  const toolCalls: ToolCallContent[] = [];
  const errors: string[] = [];
  let callIndex = 0;

  // Match ```json ... ``` or ``` ... ``` blocks containing JSON with "name" field
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gi;
  let match: RegExpExecArray | null;
  let cleanedResponse = response;

  while ((match = codeBlockRegex.exec(response)) !== null) {
    const rawJson = match[1].trim();

    // Only try to parse if it looks like a tool call (has "name" field)
    if (!/"name"\s*:/.test(rawJson)) continue;

    let parsed = tryParseToolCallJson(rawJson);

    if (!parsed) {
      parsed = extractFieldsIndependently(rawJson);
    }

    if (!parsed) {
      errors.push(`Code block tool call #${callIndex}: could not parse JSON`);
      callIndex++;
      continue;
    }

    if (!parsed.name || typeof parsed.name !== "string") {
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

  // Remove matched code blocks from text
  if (toolCalls.length > 0) {
    cleanedResponse = response.replace(codeBlockRegex, "").trim();
  }

  return { text: cleanedResponse, toolCalls, errors };
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
