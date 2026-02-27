# T-002: Configuration System

## Status: Pending

## Priority: Medium

## Summary

Implement a configuration system that allows users to customize the agent's behavior — provider selection, model choice, API endpoints, tool permissions, safety settings, and more. Configuration comes from CLI flags, environment variables, config files, and sensible defaults, merged in a well-defined precedence order.

## Context

Users need to control:
- Which LLM provider to use (ollama, openai, anthropic).
- Which model to use (llama3.1, gpt-4, claude-sonnet, etc.).
- Provider-specific settings (API keys, base URLs, temperature).
- Which tools are enabled/disabled.
- Safety settings (allow/deny dangerous commands, network access).
- UI preferences (color, verbosity).

## Detailed Implementation

### Configuration Schema

```typescript
interface Config {
  /** LLM Provider settings */
  provider: {
    /** Provider name: "ollama" | "openai" | "anthropic" */
    name: string;
    /** Base URL for the provider API */
    baseUrl: string;
    /** API key (for cloud providers) */
    apiKey?: string;
    /** Model name */
    model: string;
    /** Temperature (0-2) */
    temperature: number;
    /** Max tokens for response */
    maxTokens: number;
    /** Context window size (in tokens) */
    contextWindow: number;
  };

  /** Tool settings */
  tools: {
    /** Enabled tools (empty = all enabled) */
    enabled: string[];
    /** Disabled tools (takes precedence over enabled) */
    disabled: string[];
    /** Bash tool settings */
    bash: {
      /** Default timeout in ms */
      defaultTimeout: number;
      /** Max timeout in ms */
      maxTimeout: number;
      /** Blocked command patterns (regex strings) */
      blockedPatterns: string[];
    };
    /** File operation settings */
    files: {
      /** Max file size to read (bytes) */
      maxReadSize: number;
      /** Max file size to write (bytes) */
      maxWriteSize: number;
      /** Blocked path patterns (regex strings) */
      blockedPaths: string[];
    };
    /** HTTP request settings */
    http: {
      /** Allow requests to local/private networks */
      allowPrivateNetworks: boolean;
      /** Blocked URL patterns */
      blockedUrls: string[];
      /** Request timeout in ms */
      timeout: number;
    };
  };

  /** Agent behavior */
  agent: {
    /** Max consecutive tool-use turns before forcing a text response */
    maxToolTurns: number;
    /** System prompt override (appended to default) */
    systemPromptAppend?: string;
    /** System prompt replacement (replaces default entirely) */
    systemPromptOverride?: string;
  };

  /** UI settings */
  ui: {
    /** Enable colored output */
    color: boolean;
    /** Verbosity level: "quiet" | "normal" | "verbose" | "debug" */
    verbosity: "quiet" | "normal" | "verbose" | "debug";
    /** Show token usage after each turn */
    showTokenUsage: boolean;
    /** Show tool call details */
    showToolDetails: boolean;
  };
}
```

### Defaults

```typescript
const DEFAULT_CONFIG: Config = {
  provider: {
    name: "ollama",
    baseUrl: "http://localhost:11434",
    model: "llama3.1",
    temperature: 0.1,
    maxTokens: 4096,
    contextWindow: 8192,
  },
  tools: {
    enabled: [],
    disabled: [],
    bash: {
      defaultTimeout: 120000,
      maxTimeout: 600000,
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
      timeout: 30000,
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
```

### Configuration Sources (Precedence Order)

From lowest to highest priority:

1. **Built-in defaults** — hardcoded in the application.
2. **Global config file** — `~/.config/ollama-claude/config.json` (or `$XDG_CONFIG_HOME`).
3. **Project config file** — `.ollama-claude.json` in the working directory.
4. **Environment variables** — `OLLAMA_CLAUDE_PROVIDER`, `OLLAMA_CLAUDE_MODEL`, etc.
5. **CLI flags** — `--provider`, `--model`, `--temperature`, etc.

### Environment Variables

| Variable | Maps To |
|----------|---------|
| `OLLAMA_CLAUDE_PROVIDER` | `provider.name` |
| `OLLAMA_CLAUDE_MODEL` | `provider.model` |
| `OLLAMA_CLAUDE_BASE_URL` | `provider.baseUrl` |
| `OLLAMA_CLAUDE_API_KEY` | `provider.apiKey` |
| `OLLAMA_CLAUDE_TEMPERATURE` | `provider.temperature` |
| `OLLAMA_CLAUDE_MAX_TOKENS` | `provider.maxTokens` |
| `OPENAI_API_KEY` | `provider.apiKey` (when provider=openai) |
| `ANTHROPIC_API_KEY` | `provider.apiKey` (when provider=anthropic) |

### CLI Flags

```
ollama-claude [options]

Options:
  --provider <name>       LLM provider (ollama, openai, anthropic)
  --model <name>          Model name (e.g., llama3.1, gpt-4o, claude-sonnet)
  --base-url <url>        Provider API base URL
  --api-key <key>         API key for cloud providers
  --temperature <num>     Temperature (0-2)
  --max-tokens <num>      Max response tokens
  --context-window <num>  Context window size
  --no-color              Disable colored output
  --verbose               Enable verbose output
  --debug                 Enable debug output (very verbose)
  --help                  Show help
  --version               Show version
```

### Config Loader

```typescript
class ConfigLoader {
  async load(cliFlags: Partial<Config>): Promise<Config> {
    // 1. Start with defaults
    let config = structuredClone(DEFAULT_CONFIG);

    // 2. Merge global config file
    const globalConfig = await this.loadGlobalConfigFile();
    if (globalConfig) config = deepMerge(config, globalConfig);

    // 3. Merge project config file
    const projectConfig = await this.loadProjectConfigFile();
    if (projectConfig) config = deepMerge(config, projectConfig);

    // 4. Merge environment variables
    const envConfig = this.loadFromEnvironment();
    config = deepMerge(config, envConfig);

    // 5. Merge CLI flags (highest priority)
    config = deepMerge(config, cliFlags);

    // 6. Validate the final config
    this.validate(config);

    return config;
  }

  private async loadGlobalConfigFile(): Promise<Partial<Config> | null> {
    const configDir = process.env.XDG_CONFIG_HOME
      ?? path.join(os.homedir(), ".config");
    const configPath = path.join(configDir, "ollama-claude", "config.json");

    try {
      const content = await fs.readFile(configPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private async loadProjectConfigFile(): Promise<Partial<Config> | null> {
    const configPath = path.join(process.cwd(), ".ollama-claude.json");
    try {
      const content = await fs.readFile(configPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private loadFromEnvironment(): Partial<Config> {
    const env: Partial<Config> = {};
    // Map each env var to its config path...
    return env;
  }

  private validate(config: Config): void {
    if (config.provider.temperature < 0 || config.provider.temperature > 2) {
      throw new Error("Temperature must be between 0 and 2");
    }
    if (config.provider.maxTokens < 1) {
      throw new Error("maxTokens must be positive");
    }
    // ... more validation
  }
}
```

### Deep Merge Utility

```typescript
function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key as keyof T];
    const tgtVal = target[key as keyof T];
    if (srcVal !== undefined) {
      if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
        (result as any)[key] = deepMerge(tgtVal as any, srcVal as any);
      } else {
        (result as any)[key] = srcVal;
      }
    }
  }
  return result;
}
```

## File Locations

- `src/config/config.ts` — Config types and defaults
- `src/config/loader.ts` — Config loader (files, env, merge)
- `src/config/cli-flags.ts` — CLI flag parsing

## Acceptance Criteria

1. Default config is complete and valid.
2. Global config file loads and merges correctly.
3. Project config file loads and merges correctly.
4. Environment variables are mapped correctly.
5. CLI flags override everything else.
6. Deep merge works correctly (nested objects, arrays).
7. Invalid config values produce clear errors.
8. Missing config files are silently ignored (not errors).
9. Unit tests for each config source and merge behavior.

## Dependencies

- T-001

## Blocks

- T-004 (Ollama provider reads config)
- T-020 (CLI parses flags and passes to config)
