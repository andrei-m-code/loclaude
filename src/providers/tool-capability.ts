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
  "llama3": false,
  "codellama": false,
  "phi": false,
  "phi3": false,
  "gemma": false,
  "gemma2": false,
  "deepseek-coder": false,
  "starcoder": false,
  "stable-code": false,
};

export enum ToolCallMode {
  NATIVE = "native",
  FALLBACK = "fallback",
}

function normalizeModelName(model: string): string {
  const colonIdx = model.indexOf(":");
  return colonIdx >= 0 ? model.slice(0, colonIdx) : model;
}

async function checkModelMetadata(baseUrl: string, model: string): Promise<boolean | null> {
  try {
    const resp = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
    });
    if (!resp.ok) return null;
    const info = (await resp.json()) as { template?: string };

    const template = info.template ?? "";
    const hasToolTokens =
      template.includes("{{.Tools}}") ||
      template.includes("<|python_tag|>") ||
      template.includes("[AVAILABLE_TOOLS]");

    if (hasToolTokens) return true;

    return null; // Inconclusive
  } catch {
    return null;
  }
}

export async function detectToolCallMode(
  model: string,
  baseUrl: string,
): Promise<ToolCallMode> {
  // 1. Check known list (exact match)
  const base = normalizeModelName(model);
  if (base in NATIVE_TOOL_SUPPORT) {
    return NATIVE_TOOL_SUPPORT[base] ? ToolCallMode.NATIVE : ToolCallMode.FALLBACK;
  }

  // Partial prefix match
  for (const [known, supports] of Object.entries(NATIVE_TOOL_SUPPORT)) {
    if (base.startsWith(known)) {
      return supports ? ToolCallMode.NATIVE : ToolCallMode.FALLBACK;
    }
  }

  // 2. Check Ollama model metadata
  const metaResult = await checkModelMetadata(baseUrl, model);
  if (metaResult === true) return ToolCallMode.NATIVE;

  // 3. Default to fallback for unknown models (safer than probing)
  return ToolCallMode.FALLBACK;
}
