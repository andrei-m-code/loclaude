# T-005: Tool Call Capability Detection and Prompt-Based Fallback

## Status: Pending

## Priority: Critical

## Summary

Not all Ollama models support native tool/function calling. This task implements: (1) automatic detection of whether a model supports native tool calls, and (2) a prompt-based fallback system that teaches non-tool-calling models to emit structured tool invocations in plain text, which we then parse and execute.

## Context

The Ollama ecosystem has hundreds of models. Only a subset support native tool calling (the `tools` parameter in `/api/chat`):
- **Supports tools**: Llama 3.1+, Mistral (with tool mode), Qwen 2.5+, Command R+, Hermes 2 Pro
- **Does NOT support tools**: Llama 2, CodeLlama, Phi-2, most GGUF finetunes, many community models, older base models

If we pass `tools` to a model that doesn't support them, Ollama may:
- Silently ignore the tools and respond with plain text
- Return an error
- Hallucinate broken JSON

We need a reliable system that works with ANY model.

## Detailed Implementation

### Strategy Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Agent Loop                             │
│                                                          │
│  1. Check: does this model support native tool calls?    │
│     ┌─── YES ──────────────┐  ┌─── NO ─────────────┐    │
│     │ Use native mode:     │  │ Use fallback mode:  │    │
│     │ Pass tools array to  │  │ Embed tool schemas  │    │
│     │ /api/chat, parse     │  │ in system prompt,   │    │
│     │ tool_calls from      │  │ parse <tool_call>   │    │
│     │ response object      │  │ blocks from text    │    │
│     └──────────────────────┘  └─────────────────────┘    │
│                                                          │
│  Result: ToolCall[] (same format either way)              │
└──────────────────────────────────────────────────────────┘
```

### Part 1: Capability Detection

Three-layer detection strategy: known list → Ollama metadata → live probe.

#### Layer 1: Known Model List

```typescript
/** Models known to support native tool calling */
const NATIVE_TOOL_SUPPORT: Record<string, boolean> = {
  // Supports tools
  "llama3.1": true,
  "llama3.2": true,
  "llama3.3": true,
  "mistral": true,
  "mixtral": true,
  "qwen2.5": true,
  "qwen2.5-coder": true,
  "command-r": true,
  "command-r-plus": true,
  "hermes2-pro": true,
  "nemotron": true,
  "firefunction-v2": true,
  // Does NOT support tools
  "llama2": false,
  "codellama": false,
  "phi": false,
  "phi3": false,
  "gemma": false,
  "gemma2": false,
  "deepseek-coder": false,
  "starcoder": false,
  "stable-code": false,
};

function normalizeModelName(model: string): string {
  // "llama3.1:8b-instruct-q4_0" -> "llama3.1"
  const colonIdx = model.indexOf(":");
  return colonIdx >= 0 ? model.slice(0, colonIdx) : model;
}
```

#### Layer 2: Query Ollama Model Metadata

Ollama's `POST /api/show` returns model info. Check the template for tool-related tokens:

```typescript
async function checkModelMetadata(baseUrl: string, model: string): Promise<boolean | null> {
  try {
    const resp = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
    });
    if (!resp.ok) return null;
    const info = await resp.json();

    // Some model templates contain tool-related tokens/markers
    const template = info.template ?? "";
    const hasToolTokens = template.includes("{{.Tools}}") ||
                          template.includes("<|python_tag|>") ||
                          template.includes("[AVAILABLE_TOOLS]");
    if (hasToolTokens) return true;

    return null; // Inconclusive
  } catch {
    return null;
  }
}
```

#### Layer 3: Live Probe

Send a trivial tool call request and see if the model responds correctly:

```typescript
async function probeToolSupport(provider: OllamaProvider, model: string): Promise<boolean> {
  const testMessages: Message[] = [
    { role: "system", content: "You MUST call the get_time tool. Do not respond with text." },
    { role: "user", content: "What time is it?" },
  ];

  const testTools: ToolDefinition[] = [{
    type: "function",
    function: {
      name: "get_time",
      description: "Get the current time",
      parameters: { type: "object", properties: {}, required: [] },
    },
  }];

  try {
    const response = await provider.chat(testMessages, testTools);
    return !!(response.toolCalls && response.toolCalls.length > 0);
  } catch {
    return false;
  }
}
```

#### Combined Detection

```typescript
class ToolCapabilityDetector {
  private cache: ToolSupportCache;

  constructor(configDir: string) {
    this.cache = new ToolSupportCache(configDir);
  }

  async detect(provider: OllamaProvider, model: string, baseUrl: string): Promise<boolean> {
    // 0. Check cache first
    const cached = this.cache.get(model);
    if (cached !== undefined) return cached;

    // 1. Check known list
    const base = normalizeModelName(model);
    if (base in NATIVE_TOOL_SUPPORT) {
      const result = NATIVE_TOOL_SUPPORT[base];
      this.cache.set(model, result);
      return result;
    }
    // Partial match
    for (const [known, supports] of Object.entries(NATIVE_TOOL_SUPPORT)) {
      if (base.startsWith(known)) {
        this.cache.set(model, supports);
        return supports;
      }
    }

    // 2. Check model metadata
    const metaResult = await checkModelMetadata(baseUrl, model);
    if (metaResult !== null) {
      this.cache.set(model, metaResult);
      return metaResult;
    }

    // 3. Live probe (slow — involves one LLM call)
    console.log(`Unknown model "${model}" — probing for tool call support...`);
    const probeResult = await probeToolSupport(provider, model);
    this.cache.set(model, probeResult);
    console.log(`Result: ${probeResult ? "native tools supported" : "using prompt-based fallback"}`);
    return probeResult;
  }
}
```

#### Probe Result Cache

Persist probe results so we don't re-probe on every startup:

```typescript
class ToolSupportCache {
  private cachePath: string;
  private cache: Record<string, boolean> = {};

  constructor(configDir: string) {
    this.cachePath = path.join(configDir, "tool-support-cache.json");
    this.load();
  }

  get(model: string): boolean | undefined {
    return this.cache[model];
  }

  set(model: string, supports: boolean): void {
    this.cache[model] = supports;
    this.save();
  }

  private load(): void {
    try {
      this.cache = JSON.parse(fs.readFileSync(this.cachePath, "utf-8"));
    } catch { this.cache = {}; }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
  }
}
```

### Part 2: Prompt-Based Fallback

When a model does NOT support native tool calls, we embed tool definitions directly in the system prompt and teach the model to emit structured blocks that we parse.

#### Fallback Format

Use XML-like tags (models handle these better than raw JSON):

```
I need to read the file first.

<tool_call>
{"name": "file_read", "arguments": {"file_path": "src/index.ts"}}
</tool_call>
```

Why this format:
- XML tags are distinctive and unlikely to appear in normal conversation
- JSON inside is unambiguous and parseable
- Models trained on web data have seen XML extensively
- Single-line JSON is easier for models to produce correctly than multi-line

#### System Prompt Additions for Fallback Mode

```typescript
function buildFallbackToolPrompt(tools: ToolDefinition[]): string {
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
    const fn = tool.function;
    prompt += `### ${fn.name}\n`;
    prompt += `${fn.description}\n`;
    prompt += `Parameters:\n`;
    prompt += "```json\n" + JSON.stringify(fn.parameters, null, 2) + "\n```\n\n";
  }

  prompt += `## Example\n\nUser: "Read the file src/index.ts"\n\nAssistant: I'll read that file for you.\n\n<tool_call>\n{"name": "file_read", "arguments": {"file_path": "src/index.ts"}}\n</tool_call>`;

  return prompt;
}
```

#### Fallback Response Parser

Parse `<tool_call>` blocks from the model's plain-text response:

```typescript
interface ParsedFallbackResponse {
  /** Text content with tool_call blocks removed */
  text: string;
  /** Parsed tool calls */
  toolCalls: ToolCall[];
  /** Parsing errors (malformed JSON, etc.) */
  errors: string[];
}

function parseFallbackToolCalls(response: string): ParsedFallbackResponse {
  const toolCalls: ToolCall[] = [];
  const errors: string[] = [];
  let callIndex = 0;

  // Match all <tool_call>...</tool_call> blocks
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

  let text = response;
  let match: RegExpExecArray | null;

  while ((match = toolCallRegex.exec(response)) !== null) {
    const rawJson = match[1].trim();

    try {
      const parsed = JSON.parse(rawJson);

      if (!parsed.name || typeof parsed.name !== "string") {
        errors.push(`Tool call #${callIndex}: missing or invalid "name" field`);
        continue;
      }

      toolCalls.push({
        id: `fallback_call_${callIndex}`,
        type: "function",
        function: {
          name: parsed.name,
          arguments: JSON.stringify(parsed.arguments ?? {}),
        },
      });
    } catch (err) {
      errors.push(`Tool call #${callIndex}: invalid JSON — ${err.message}`);

      // Attempt recovery: try to fix common JSON issues
      const recovered = attemptJsonRecovery(rawJson);
      if (recovered) {
        toolCalls.push({
          id: `fallback_call_${callIndex}`,
          type: "function",
          function: {
            name: recovered.name,
            arguments: JSON.stringify(recovered.arguments ?? {}),
          },
        });
        errors.pop(); // Remove the error since we recovered
      }
    }
    callIndex++;
  }

  // Remove tool_call blocks from text to get the "content" portion
  text = response.replace(toolCallRegex, "").trim();

  return { text: text || null, toolCalls, errors };
}
```

#### JSON Recovery for Common Model Mistakes

Models sometimes produce slightly malformed JSON. Handle common cases:

```typescript
function attemptJsonRecovery(raw: string): { name: string; arguments: Record<string, unknown> } | null {
  let fixed = raw;

  // Fix 1: Trailing commas — {"key": "value",} -> {"key": "value"}
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");

  // Fix 2: Single quotes — {'key': 'value'} -> {"key": "value"}
  fixed = fixed.replace(/'/g, '"');

  // Fix 3: Unquoted keys — {key: "value"} -> {"key": "value"}
  fixed = fixed.replace(/(\{|,)\s*(\w+)\s*:/g, '$1"$2":');

  // Fix 4: Multi-line JSON — join lines
  fixed = fixed.replace(/\n\s*/g, " ");

  try {
    return JSON.parse(fixed);
  } catch {
    return null;
  }
}
```

#### Tool Result Injection for Fallback Mode

After executing tools in fallback mode, we inject results back as a user message (since there's no native "tool" role for non-tool-calling models):

```typescript
function buildFallbackToolResultMessage(results: ToolResult[]): Message {
  let content = "Tool results:\n\n";

  for (const result of results) {
    content += `<tool_result name="${result.toolName}">\n`;
    content += result.output;
    content += `\n</tool_result>\n\n`;
  }

  content += "Continue based on these results. If you need to call more tools, use <tool_call> blocks. Otherwise, respond to the user.";

  return {
    role: "user",  // Not "tool" — the model doesn't understand that role
    content,
  };
}
```

### Part 3: Integration with Provider/Agent

#### ToolCallMode Enum

```typescript
enum ToolCallMode {
  /** Model supports native tool calling — use tools API parameter */
  NATIVE = "native",
  /** Model does NOT support native tools — use prompt-based fallback */
  FALLBACK = "fallback",
}
```

#### Provider Wrapper

Wrap the provider to transparently handle both modes:

```typescript
class ToolCallAdapter {
  private mode: ToolCallMode;
  private provider: LLMProvider;

  constructor(provider: LLMProvider, mode: ToolCallMode) {
    this.provider = provider;
    this.mode = mode;
  }

  async chat(
    messages: Message[],
    tools: ToolDefinition[],
    systemPrompt: string,
  ): Promise<{ content: string | null; toolCalls: ToolCall[] }> {
    if (this.mode === ToolCallMode.NATIVE) {
      // Native mode: pass tools to the API
      const response = await this.provider.chat(messages, tools);
      return {
        content: response.content,
        toolCalls: response.toolCalls ?? [],
      };
    } else {
      // Fallback mode: embed tools in system prompt, parse from text
      const fallbackPrompt = systemPrompt + "\n\n" + buildFallbackToolPrompt(tools);
      const messagesWithPrompt = [
        { role: "system" as const, content: fallbackPrompt },
        ...messages.filter(m => m.role !== "system"),
      ];

      const response = await this.provider.chat(messagesWithPrompt);
      const parsed = parseFallbackToolCalls(response.content ?? "");

      if (parsed.errors.length > 0) {
        console.warn("Tool call parse warnings:", parsed.errors);
      }

      return {
        content: parsed.text || null,
        toolCalls: parsed.toolCalls,
      };
    }
  }
}
```

### Part 4: User-Facing Behavior

On startup, the CLI shows which mode was detected:

```
 ollama-claude v0.1.0
 Provider: ollama | Model: phi3:mini
 Tool mode: prompt-based fallback (model does not support native tools)
 Type /help for commands
```

Or:

```
 ollama-claude v0.1.0
 Provider: ollama | Model: llama3.1:8b
 Tool mode: native
 Type /help for commands
```

Users can also force a mode via config/CLI flag:

```
--tool-mode native     # Force native (errors if model doesn't support it)
--tool-mode fallback   # Force fallback (works with any model)
--tool-mode auto       # Default: auto-detect
```

## File Locations

- `src/providers/tool-capability.ts` — Detection logic, known model list, cache
- `src/providers/tool-fallback.ts` — Fallback prompt builder, response parser, JSON recovery
- `src/providers/tool-adapter.ts` — Unified adapter that wraps provider with mode handling

## Acceptance Criteria

1. Known models (Llama 3.1, Llama 2, etc.) are detected without probing.
2. Unknown models are probed with a test call and the result is cached.
3. Probe cache persists to disk and loads on next startup.
4. Fallback mode: tool definitions are embedded in the system prompt.
5. Fallback mode: `<tool_call>` blocks are correctly parsed from response text.
6. Fallback mode: malformed JSON is recovered when possible (trailing commas, single quotes, unquoted keys).
7. Fallback mode: tool results are injected back as user messages.
8. Fallback mode: multiple tool calls in one response are handled.
9. Agent loop works identically in both modes (same ToolCall[] output).
10. CLI/banner shows which tool mode is active.
11. `--tool-mode` flag allows forcing a specific mode.
12. Unit tests for:
    - Known model lookup and normalization
    - Fallback response parsing (valid, malformed, empty, multiple calls)
    - JSON recovery
    - Adapter in both modes

## Dependencies

- T-001, T-003 (Provider Abstraction), T-004 (Ollama Provider)

## Blocks

- T-017 (System Prompt — needs fallback prompt additions)
- T-018 (Agent Loop — uses ToolCallAdapter)
- T-019 (Streaming — fallback mode needs stream-then-parse)