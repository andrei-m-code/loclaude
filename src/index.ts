import { loadConfig } from "./config/index.js";
import { createProvider } from "./providers/factory.js";
import { ToolRegistry } from "./tools/registry.js";
import { FileReadTool } from "./tools/file-read.js";
import { BashTool } from "./tools/bash.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import { Agent } from "./agent/agent.js";
import { startRepl } from "./cli/repl.js";

async function main() {
  // 1. Load config
  const config = loadConfig();

  // 2. Create provider
  const provider = createProvider({
    provider: config.provider.name,
    baseUrl: config.provider.baseUrl,
    defaultModel: config.provider.model,
    apiKey: config.provider.apiKey,
  });

  // 3. Create tool registry
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(new FileReadTool());
  toolRegistry.register(new BashTool(process.cwd()));

  // 4. Build system prompt
  const systemPrompt = buildSystemPrompt({
    tools: toolRegistry.getToolDefinitions(),
    workingDirectory: process.cwd(),
    providerName: provider.displayName,
    modelName: config.provider.model,
  });

  // 5. Create agent
  const agent = new Agent({
    provider,
    toolRegistry,
    config: {
      model: config.provider.model,
      systemPrompt,
      baseUrl: config.provider.baseUrl,
      workingDirectory: process.cwd(),
      temperature: config.provider.temperature,
      maxTokens: config.provider.maxTokens,
      maxTurns: config.agent.maxToolTurns,
    },
  });

  // 6. Start REPL
  await startRepl({
    agent,
    providerName: config.provider.name,
    modelName: config.provider.model,
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
