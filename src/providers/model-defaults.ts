/**
 * Model-aware defaults for known Ollama models.
 * Provides sensible num_ctx, max tool result length, and temperature
 * based on model capabilities. Explicit config always overrides these.
 */

export interface ModelDefaults {
  numCtx: number;
  maxToolResultLength: number;
  temperature: number;
}

const FALLBACK_DEFAULTS: ModelDefaults = {
  numCtx: 32768,
  maxToolResultLength: 8000,
  temperature: 0.1,
};

/**
 * Known model families and their optimal defaults.
 * Key is a prefix that matches the model name (e.g., "qwen3" matches "qwen3:8b").
 */
const MODEL_TABLE: Array<{ pattern: string; defaults: ModelDefaults }> = [
  // Qwen family — large context, good at tool calling
  { pattern: "qwen3", defaults: { numCtx: 32768, maxToolResultLength: 8000, temperature: 0.1 } },
  { pattern: "qwen2.5-coder", defaults: { numCtx: 32768, maxToolResultLength: 8000, temperature: 0.1 } },
  { pattern: "qwen2.5", defaults: { numCtx: 32768, maxToolResultLength: 8000, temperature: 0.1 } },
  { pattern: "qwen2", defaults: { numCtx: 32768, maxToolResultLength: 8000, temperature: 0.1 } },

  // DeepSeek family
  { pattern: "deepseek-coder-v2", defaults: { numCtx: 32768, maxToolResultLength: 8000, temperature: 0.1 } },
  { pattern: "deepseek-coder", defaults: { numCtx: 16384, maxToolResultLength: 6000, temperature: 0.1 } },
  { pattern: "deepseek-v2", defaults: { numCtx: 32768, maxToolResultLength: 8000, temperature: 0.1 } },
  { pattern: "deepseek", defaults: { numCtx: 16384, maxToolResultLength: 6000, temperature: 0.1 } },

  // Llama family
  { pattern: "llama3.3", defaults: { numCtx: 32768, maxToolResultLength: 8000, temperature: 0.1 } },
  { pattern: "llama3.2", defaults: { numCtx: 32768, maxToolResultLength: 8000, temperature: 0.1 } },
  { pattern: "llama3.1", defaults: { numCtx: 32768, maxToolResultLength: 8000, temperature: 0.1 } },
  { pattern: "llama3", defaults: { numCtx: 8192, maxToolResultLength: 6000, temperature: 0.1 } },
  { pattern: "llama2", defaults: { numCtx: 4096, maxToolResultLength: 3000, temperature: 0.1 } },
  { pattern: "codellama", defaults: { numCtx: 16384, maxToolResultLength: 6000, temperature: 0.1 } },

  // Mistral family
  { pattern: "mistral-nemo", defaults: { numCtx: 32768, maxToolResultLength: 8000, temperature: 0.1 } },
  { pattern: "mistral-small", defaults: { numCtx: 32768, maxToolResultLength: 8000, temperature: 0.1 } },
  { pattern: "mistral", defaults: { numCtx: 32768, maxToolResultLength: 8000, temperature: 0.1 } },
  { pattern: "mixtral", defaults: { numCtx: 32768, maxToolResultLength: 8000, temperature: 0.1 } },

  // Code-focused models
  { pattern: "starcoder2", defaults: { numCtx: 16384, maxToolResultLength: 6000, temperature: 0.1 } },
  { pattern: "starcoder", defaults: { numCtx: 8192, maxToolResultLength: 4000, temperature: 0.1 } },
  { pattern: "codegemma", defaults: { numCtx: 8192, maxToolResultLength: 6000, temperature: 0.1 } },

  // Gemma family
  { pattern: "gemma2", defaults: { numCtx: 8192, maxToolResultLength: 6000, temperature: 0.1 } },
  { pattern: "gemma", defaults: { numCtx: 8192, maxToolResultLength: 4000, temperature: 0.1 } },

  // Phi family
  { pattern: "phi4", defaults: { numCtx: 16384, maxToolResultLength: 6000, temperature: 0.1 } },
  { pattern: "phi3", defaults: { numCtx: 4096, maxToolResultLength: 4000, temperature: 0.1 } },

  // Command-R
  { pattern: "command-r", defaults: { numCtx: 32768, maxToolResultLength: 8000, temperature: 0.1 } },

  // Anthropic Claude models — large context windows, excellent tool calling
  { pattern: "claude-opus", defaults: { numCtx: 200000, maxToolResultLength: 16000, temperature: 0.1 } },
  { pattern: "claude-sonnet", defaults: { numCtx: 200000, maxToolResultLength: 16000, temperature: 0.1 } },
  { pattern: "claude-haiku", defaults: { numCtx: 200000, maxToolResultLength: 16000, temperature: 0.1 } },
  { pattern: "claude-3", defaults: { numCtx: 200000, maxToolResultLength: 16000, temperature: 0.1 } },
];

/**
 * Get model-aware defaults for a given model name.
 * Matches against known model patterns, falls back to sensible defaults.
 */
export function getModelDefaults(model: string): ModelDefaults {
  const normalizedModel = model.toLowerCase();

  for (const entry of MODEL_TABLE) {
    if (normalizedModel.startsWith(entry.pattern)) {
      return { ...entry.defaults };
    }
  }

  return { ...FALLBACK_DEFAULTS };
}
