import type { LLMProvider } from "./types.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";

export interface ProviderConfig {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  maxRetries?: number;
}

export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.provider) {
    case "ollama":
      return new OllamaProvider({
        baseUrl: config.baseUrl ?? "http://localhost:11434",
        defaultModel: config.defaultModel ?? "deepseek-coder:6.7b",
      });
    case "openai":
      return new OpenAIProvider({
        apiKey: config.apiKey ?? "",
        baseUrl: config.baseUrl ?? "https://api.openai.com",
        defaultModel: config.defaultModel ?? "gpt-4o-mini",
        maxRetries: config.maxRetries,
      });
    default:
      throw new Error(`Unknown provider: ${config.provider}. Supported: ollama, openai`);
  }
}
