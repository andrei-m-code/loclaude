import type { Config } from "./config.js";

export const DEFAULT_CONFIG: Config = {
  provider: {
    name: "ollama",
    baseUrl: "http://localhost:11434",
    model: "qwen3:8b",
    temperature: 0.1,
    maxTokens: 4096,
    contextWindow: 8192,
  },
  tools: {
    enabled: [],
    disabled: [],
    bash: {
      defaultTimeout: 120_000,
      maxTimeout: 600_000,
      blockedPatterns: [],
    },
    files: {
      maxReadSize: 10 * 1024 * 1024,
      maxWriteSize: 10 * 1024 * 1024,
      blockedPaths: [],
    },
    http: {
      allowPrivateNetworks: false,
      blockedUrls: [],
      timeout: 30_000,
    },
  },
  agent: {
    maxToolTurns: 25,
  },
  ui: {
    color: true,
    verbosity: "normal",
    showTokenUsage: false,
    showToolDetails: true,
  },
};
