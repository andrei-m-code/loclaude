import { loadConfig } from "./config/index.js";
import { createProvider } from "./providers/factory.js";
import { ToolRegistry } from "./tools/registry.js";
import { FileReadTool } from "./tools/file-read.js";
import { FileWriteTool } from "./tools/file-write.js";
import { FileEditTool } from "./tools/file-edit.js";
import { FileDeleteTool } from "./tools/file-delete.js";
import { GlobTool } from "./tools/glob.js";
import { GrepTool } from "./tools/grep.js";
import { BashTool } from "./tools/bash.js";
import { HttpRequestTool } from "./tools/http-request.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import { scanWorkspace } from "./agent/workspace-scan.js";
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
  const cwd = process.cwd();
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(new FileReadTool(cwd));
  toolRegistry.register(new FileWriteTool(cwd));
  toolRegistry.register(new FileEditTool(cwd));
  toolRegistry.register(new FileDeleteTool(cwd));
  toolRegistry.register(new GlobTool());
  toolRegistry.register(new GrepTool());
  toolRegistry.register(new BashTool(cwd));
  toolRegistry.register(new HttpRequestTool());

  // 4. Scan workspace and build system prompt
  const workspaceContext = await scanWorkspace(cwd);
  const systemPrompt = buildSystemPrompt({
    tools: toolRegistry.getToolDefinitions(),
    workingDirectory: cwd,
    providerName: provider.displayName,
    modelName: config.provider.model,
    workspaceContext,
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
