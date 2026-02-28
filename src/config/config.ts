export interface Config {
  provider: {
    name: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
    temperature: number;
    maxTokens: number;
    contextWindow: number;
  };

  tools: {
    enabled: string[];
    disabled: string[];
    bash: {
      defaultTimeout: number;
      maxTimeout: number;
      blockedPatterns: string[];
    };
    files: {
      maxReadSize: number;
      maxWriteSize: number;
      blockedPaths: string[];
    };
    http: {
      allowPrivateNetworks: boolean;
      blockedUrls: string[];
      timeout: number;
    };
  };

  agent: {
    maxToolTurns: number;
    maxContextChars?: number;
    maxToolResultLength?: number;
    systemPromptAppend?: string;
    systemPromptOverride?: string;
  };

  ui: {
    color: boolean;
    verbosity: "quiet" | "normal" | "verbose" | "debug";
    showTokenUsage: boolean;
    showToolDetails: boolean;
  };
}
