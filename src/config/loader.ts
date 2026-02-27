import type { Config } from "./config.js";
import { DEFAULT_CONFIG } from "./defaults.js";

function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceVal = source[key];
    if (sourceVal === undefined) continue;
    const targetVal = result[key];
    if (
      targetVal &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal) &&
      sourceVal &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      result[key] = sourceVal as T[keyof T];
    }
  }
  return result;
}

function loadFromEnvironment(): Partial<Config> {
  const env: Partial<Config> = {};
  const p = process.env;

  const provider: Partial<Config["provider"]> = {};
  if (p.OLLAMA_CLAUDE_PROVIDER) provider.name = p.OLLAMA_CLAUDE_PROVIDER;
  if (p.OLLAMA_CLAUDE_MODEL) provider.model = p.OLLAMA_CLAUDE_MODEL;
  if (p.OLLAMA_CLAUDE_BASE_URL) provider.baseUrl = p.OLLAMA_CLAUDE_BASE_URL;
  if (p.OLLAMA_CLAUDE_API_KEY) provider.apiKey = p.OLLAMA_CLAUDE_API_KEY;
  if (p.OLLAMA_CLAUDE_TEMPERATURE) provider.temperature = parseFloat(p.OLLAMA_CLAUDE_TEMPERATURE);
  if (p.OLLAMA_CLAUDE_MAX_TOKENS) provider.maxTokens = parseInt(p.OLLAMA_CLAUDE_MAX_TOKENS, 10);

  if (Object.keys(provider).length > 0) {
    env.provider = provider as Config["provider"];
  }

  return env;
}

export function loadConfig(): Config {
  const envConfig = loadFromEnvironment();
  return deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, envConfig as unknown as Record<string, unknown>) as unknown as Config;
}
