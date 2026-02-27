import type { LLMProvider } from "./types.js";
import { OllamaProvider } from "./ollama.js";

export interface ProviderConfig {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
}

export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.provider) {
    case "ollama":
      return new OllamaProvider({
        baseUrl: config.baseUrl ?? "http://localhost:11434",
        defaultModel: config.defaultModel ?? "deepseek-coder:6.7b",
      });
    default:
      throw new Error(`Unknown provider: ${config.provider}. Supported: ollama`);
  }
}
