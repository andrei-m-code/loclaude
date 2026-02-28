import * as path from "node:path";
import * as fs from "node:fs";
import { loadConfig, loadSession, type SessionConfig } from "./config/index.js";
import { createProvider } from "./providers/factory.js";
import { getModelDefaults } from "./providers/model-defaults.js";
import { ToolRegistry } from "./tools/registry.js";
import { FileReadTool } from "./tools/file-read.js";
import { FileWriteTool } from "./tools/file-write.js";
import { FileEditTool } from "./tools/file-edit.js";
import { FileDeleteTool } from "./tools/file-delete.js";
import { GlobTool } from "./tools/glob.js";
import { GrepTool } from "./tools/grep.js";
import { ListDirectoryTool } from "./tools/list-directory.js";
import { BashTool } from "./tools/bash.js";
import { HttpRequestTool } from "./tools/http-request.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import { scanWorkspace } from "./agent/workspace-scan.js";
import { Agent } from "./agent/agent.js";
import { startRepl } from "./cli/repl.js";

function parseArgs(argv: string[]): { cwd?: string; help?: boolean } {
  const result: { cwd?: string; help?: boolean } = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-C" || arg === "--cwd") {
      result.cwd = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      result.help = true;
    } else if (arg.startsWith("-C=") || arg.startsWith("--cwd=")) {
      result.cwd = arg.split("=").slice(1).join("=");
    } else {
      // Treat bare positional arg as directory
      result.cwd = arg;
    }
  }
  return result;
}

function printUsage(): void {
  console.log(`Usage: ollama-claude [options] [directory]

Options:
  -C, --cwd <path>   Start in the given directory (default: current directory)
  -h, --help          Show this help message

Environment variables:
  OLLAMA_CLAUDE_MODEL       Model name (e.g. qwen3:8b)
  OLLAMA_CLAUDE_BASE_URL    Ollama API URL (default: http://localhost:11434)
  OLLAMA_CLAUDE_PROVIDER    Provider name (default: ollama)
  OLLAMA_CLAUDE_API_KEY     API key (for non-Ollama providers)
  OLLAMA_CLAUDE_TEMPERATURE Temperature (default: 0.1)
  OLLAMA_CLAUDE_MAX_TOKENS  Max tokens per response`);
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  // 1. Load config (env vars + defaults)
  const config = loadConfig();

  // 2. Resolve working directory
  let cwd = process.cwd();
  if (args.cwd) {
    cwd = path.resolve(args.cwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      console.error(`Error: '${args.cwd}' is not a valid directory.`);
      process.exit(1);
    }
    process.chdir(cwd);
  }

  // 3. Load session config (LOCLAUDE.md) — merge with env/defaults
  const session = loadSession(cwd);
  const needsOnboarding = session === null;

  // Merge: env vars > session > defaults
  const providerName = config.provider.name !== "ollama" ? config.provider.name
    : session?.provider ?? config.provider.name;
  const modelName = process.env.OLLAMA_CLAUDE_MODEL
    ? config.provider.model
    : session?.model ?? config.provider.model;
  const apiKey = process.env.OLLAMA_CLAUDE_API_KEY
    ? config.provider.apiKey
    : session?.apiKeys?.[providerName] ?? config.provider.apiKey;
  const baseUrl = process.env.OLLAMA_CLAUDE_BASE_URL
    ? config.provider.baseUrl
    : session?.baseUrl ?? config.provider.baseUrl;

  // 4. Create provider
  const maxRetries = session?.maxRetries;
  const provider = createProvider({
    provider: providerName,
    baseUrl,
    defaultModel: modelName,
    apiKey,
    maxRetries,
  });

  // 5. Create tool registry
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(new FileReadTool(cwd));
  toolRegistry.register(new FileWriteTool(cwd));
  toolRegistry.register(new FileEditTool(cwd));
  toolRegistry.register(new FileDeleteTool(cwd));
  toolRegistry.register(new GlobTool());
  toolRegistry.register(new GrepTool());
  toolRegistry.register(new ListDirectoryTool());
  const bashTool = new BashTool(cwd);
  toolRegistry.register(bashTool);
  toolRegistry.register(new HttpRequestTool());

  // 6. Scan workspace and build system prompt
  const workspaceContext = await scanWorkspace(cwd);
  const systemPrompt = buildSystemPrompt({
    tools: toolRegistry.getToolDefinitions(),
    workingDirectory: cwd,
    providerName: provider.displayName,
    modelName,
    workspaceContext,
  });

  // 7. Create agent (model defaults as base, explicit config overrides)
  const modelDefaults = getModelDefaults(modelName);

  const agent = new Agent({
    provider,
    toolRegistry,
    config: {
      model: modelName,
      systemPrompt,
      baseUrl,
      workingDirectory: cwd,
      workspaceContext,
      temperature: config.provider.temperature ?? modelDefaults.temperature,
      maxTokens: config.provider.maxTokens,
      maxTurns: config.agent.maxToolTurns,
      maxContextChars: config.agent.maxContextChars,
      maxToolResultLength: config.agent.maxToolResultLength ?? modelDefaults.maxToolResultLength,
      contextWindow: config.provider.contextWindow ?? modelDefaults.numCtx,
    },
  });

  // 8. Build initial session state for REPL to track
  const initialSession: SessionConfig = {
    provider: providerName,
    model: modelName,
    apiKeys: apiKey ? { [providerName]: apiKey } : session?.apiKeys,
    baseUrl: providerName !== "ollama" ? baseUrl : session?.baseUrl,
    maxRetries: session?.maxRetries ?? 3,
  };

  // 9. Start REPL (with onboarding flag + session state)
  await startRepl({
    agent,
    providerName,
    modelName,
    workingDirectory: cwd,
    cwd,
    session: initialSession,
    needsOnboarding,
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
