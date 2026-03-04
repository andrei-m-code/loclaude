import * as path from "node:path";
import chalk from "chalk";
import type { Agent, AgentEvent } from "../agent/agent.js";
import { TerminalUI, formatElapsed } from "./terminal-ui.js";
import { Renderer } from "./renderer.js";
import { detectToolCallMode, ToolCallMode } from "../providers/tool-capability.js";
import { createProvider } from "../providers/factory.js";
import { saveSession, type SessionConfig } from "../config/session.js";
import type { SelectorItem } from "./selector.js";

const SUPPORTED_PROVIDERS = ["ollama", "openai", "anthropic"];

interface ReplOptions {
  agent: Agent;
  providerName: string;
  modelName: string;
  workingDirectory: string;
  cwd: string;
  session: SessionConfig;
  needsOnboarding: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export async function startRepl(options: ReplOptions): Promise<never> {
  const { agent } = options;
  const folderName = path.basename(options.workingDirectory);

  // Mutable session state — saved to LOCLAUDE.md on changes
  let session: SessionConfig = { ...options.session };
  const cwd = options.cwd;

  let running = false;
  let totalIn = 0;
  let totalOut = 0;

  function buildStatusText(): string {
    const currentDir = agent.getCurrentDir();
    const relative = path.relative(options.workingDirectory, currentDir);
    const displayDir = relative ? `${folderName}/${relative}` : folderName;
    const providerLabel = session.provider ?? "ollama";
    return `${providerLabel}/${agent.getModel()} | ${displayDir} | in:${formatTokens(totalIn)} out:${formatTokens(totalOut)}`;
  }

  function persistSession(): void {
    saveSession(cwd, session);
  }

  const ui = new TerminalUI({
    onSubmit: (text) => {
      handleSubmit(text).catch((err) => {
        ui.setRunning(false);
        running = false;
        ui.ensureInputReady();
        renderer.renderError(err instanceof Error ? err : new Error(String(err)));
      });
    },
    onInterrupt: () => {
      if (running) {
        // TODO: abort the agent run via AbortController
        ui.writeLine(chalk.yellow("[Cancelled]"));
        ui.setRunning(false);
        running = false;
        ui.ensureInputReady();
      } else {
        ui.stop();
        console.log("Goodbye!");
        process.exit(0);
      }
    },
  });

  const renderer = new Renderer(ui);

  ui.start();
  ui.setCompletions(["/help", "/model", "/provider", "/clear", "/tools", "/exit", "/quit"]);
  ui.setStatus(buildStatusText());

  // -- Onboarding flow --
  if (options.needsOnboarding) {
    await runOnboarding(agent, ui, session, cwd, persistSession);
    ui.setStatus(buildStatusText());
  }

  async function handleSubmit(text: string): Promise<void> {
    if (running) return;

    // Show what the user typed in the output area
    ui.writeLine(chalk.bold.green("> ") + text);

    // Slash commands
    if (text.startsWith("/")) {
      await handleSlashCommand(text, agent, ui, renderer, session, cwd, persistSession);
      ui.setStatus(buildStatusText());
      return;
    }

    // Run agent
    running = true;
    ui.setRunning(true);
    ui.startSpinner("Thinking...");
    ui.writeLine(""); // blank line before response

    const requestStart = Date.now();
    let firstTextChunk = true;
    ui.startInlineSpinner(requestStart);

    try {
      for await (const event of agent.run(text)) {
        if (!running) break;

        switch (event.type) {
          case "text_delta":
            if (firstTextChunk) {
              ui.stopInlineSpinner();
              ui.stopSpinner();
              firstTextChunk = false;
            }
            ui.write(event.text);
            break;

          case "text_done":
            // Already streamed via text_delta
            break;

          case "tool_call_start":
            break;

          case "tool_call_args_delta":
            break;

          case "tool_call_ready":
            // Show tool call in output
            ui.stopInlineSpinner();
            if (!firstTextChunk) {
              ui.writeLine(""); // newline after streamed text
            }
            firstTextChunk = true; // reset for next text chunk
            renderer.renderToolCall(event.toolName, event.args);
            ui.startSpinner(`Running ${event.toolName}...`);
            break;

          case "tool_result":
            ui.stopSpinner();
            renderer.renderToolResult(event.toolName, event.result, event.isError);
            ui.startSpinner("Thinking...");
            firstTextChunk = true;
            ui.startInlineSpinner(requestStart);
            break;

          case "usage":
            totalIn += event.promptTokens;
            totalOut += event.completionTokens;
            ui.setStatus(buildStatusText());
            break;

          case "turn_complete":
            // Brief indicator that the model is continuing with more actions
            ui.stopInlineSpinner();
            ui.writeLine(chalk.dim("  ↳ continuing..."));
            ui.startSpinner("Thinking...");
            firstTextChunk = true;
            ui.startInlineSpinner(requestStart);
            break;

          case "loop_complete":
            // Restart spinner — more phases may follow (e.g. verify after execute).
            // The post-loop cleanup below will stop it for good when the agent finishes.
            ui.startSpinner("Thinking...");
            firstTextChunk = true;
            ui.startInlineSpinner(requestStart);
            break;

          case "plan_ready":
            renderer.renderPlan(event.steps);
            break;

          case "step_start":
            ui.stopInlineSpinner();
            if (!firstTextChunk) ui.writeLine("");
            renderer.renderStepStart(event.stepNumber, event.totalSteps, event.description);
            ui.startSpinner(`Step ${event.stepNumber}/${event.totalSteps}...`);
            firstTextChunk = true;
            ui.startInlineSpinner(requestStart);
            break;

          case "step_end":
            ui.stopInlineSpinner();
            ui.stopSpinner();
            if (!firstTextChunk) ui.writeLine("");
            renderer.renderStepEnd(event.stepNumber, event.success);
            // Restart spinner — next step or verify phase may follow
            ui.startSpinner("Thinking...");
            firstTextChunk = true;
            ui.startInlineSpinner(requestStart);
            break;

          case "error":
            ui.stopInlineSpinner();
            ui.stopSpinner();
            renderer.renderError(event.error);
            break;

          case "warning":
            renderer.renderWarning(event.message);
            break;
        }
      }
    } catch (err) {
      ui.stopInlineSpinner();
      ui.stopSpinner();
      renderer.renderError(err instanceof Error ? err : new Error(String(err)));
    }

    // Ensure we end on a new line
    ui.stopInlineSpinner();
    if (!firstTextChunk) {
      ui.writeLine("");
    }
    // Report elapsed time
    const elapsed = (Date.now() - requestStart) / 1000;
    ui.writeLine(chalk.dim(`  Done in ${formatElapsed(elapsed)}`));
    ui.writeLine(""); // blank line after response
    ui.stopSpinner();
    // Restore persistent status with token counts and current dir
    ui.setStatus(buildStatusText());
    ui.setRunning(false);
    running = false;
    ui.ensureInputReady();
  }

  // Block forever — process exits via Ctrl+C/Ctrl+D or /exit
  return new Promise<never>(() => {});
}

// -- Onboarding --

async function runOnboarding(
  agent: Agent,
  ui: TerminalUI,
  session: SessionConfig,
  cwd: string,
  persistSession: () => void,
): Promise<void> {
  ui.writeLine(chalk.bold("\nWelcome to ollama-claude!\n"));
  ui.writeLine(chalk.dim("Let's set up your provider and model.\n"));

  // 1. Pick provider
  const providerItems: SelectorItem[] = SUPPORTED_PROVIDERS.map((p) => ({
    id: p,
    label: p,
    detail: p === "ollama" ? "Local models" : p === "openai" ? "OpenAI API" : "Anthropic Claude API",
    isActive: p === (session.provider ?? "ollama"),
  }));

  const selectedProvider = await ui.openSelector(providerItems, { title: "Select a provider" });
  const providerName = selectedProvider ?? "ollama";
  session.provider = providerName;

  // 2. Provider-specific setup
  let baseUrl: string | undefined;
  let apiKey: string | undefined;

  if (providerName === "ollama") {
    const defaultUrl = "http://localhost:11434";
    const enteredUrl = await ui.prompt("Enter Ollama URL:", { defaultValue: defaultUrl });
    baseUrl = enteredUrl || defaultUrl;

    // Health check the chosen URL
    let provider = createProvider({ provider: "ollama", baseUrl });
    let health = await provider.healthCheck();

    if (!health.ok) {
      ui.writeLine(chalk.yellow(`Cannot reach Ollama at ${baseUrl}.`));
      const retryUrl = await ui.prompt("Enter a different URL (or press Enter to continue):", { defaultValue: baseUrl });
      if (retryUrl && retryUrl !== baseUrl) {
        baseUrl = retryUrl;
        provider = createProvider({ provider: "ollama", baseUrl });
        health = await provider.healthCheck();
        if (!health.ok) {
          ui.writeLine(chalk.red(`Still cannot reach Ollama at ${baseUrl}. Continuing anyway.`));
        }
      }
    }

    session.baseUrl = baseUrl;

    // Pick model
    const modelName = await pickModel(provider, agent.getModel(), ui);
    if (modelName) {
      session.model = modelName;
      agent.setModel(modelName);
      agent.setProvider(provider, baseUrl);
    }
  } else if (providerName === "openai") {
    apiKey = session.apiKeys?.openai;
    if (!apiKey) {
      apiKey = await ui.prompt("Enter OpenAI API key:", { secret: true });
    }
    if (!apiKey) {
      ui.writeLine(chalk.yellow("No API key provided. You can set it later with /provider openai."));
      return;
    }

    session.apiKeys = { ...session.apiKeys, openai: apiKey };
    baseUrl = "https://api.openai.com";
    session.baseUrl = baseUrl;

    const provider = createProvider({ provider: "openai", apiKey, baseUrl, maxRetries: session.maxRetries });
    agent.setProvider(provider, baseUrl);

    // Pick model
    const modelName = await pickModel(provider, "gpt-4o-mini", ui);
    if (modelName) {
      session.model = modelName;
      agent.setModel(modelName);
    }
  } else if (providerName === "anthropic") {
    apiKey = session.apiKeys?.anthropic;
    if (!apiKey) {
      apiKey = await ui.prompt("Enter Anthropic API key:", { secret: true });
    }
    if (!apiKey) {
      ui.writeLine(chalk.yellow("No API key provided. You can set it later with /provider anthropic."));
      return;
    }

    session.apiKeys = { ...session.apiKeys, anthropic: apiKey };
    baseUrl = "https://api.anthropic.com";
    session.baseUrl = baseUrl;

    const provider = createProvider({ provider: "anthropic", apiKey, baseUrl, maxRetries: session.maxRetries });
    agent.setProvider(provider, baseUrl);

    // Pick model
    const modelName = await pickModel(provider, "claude-sonnet-4-20250514", ui);
    if (modelName) {
      session.model = modelName;
      agent.setModel(modelName);
    }
  }

  // Save session
  persistSession();
  ui.writeLine(chalk.green("\nSetup complete! Session saved to LOCLAUDE.md.\n"));
}

// -- Slash commands --

async function handleSlashCommand(
  input: string,
  agent: Agent,
  ui: TerminalUI,
  renderer: Renderer,
  session: SessionConfig,
  cwd: string,
  persistSession: () => void,
): Promise<void> {
  const parts = input.split(/\s+/);
  const cmd = parts[0];
  const arg = parts.slice(1).join(" ");

  switch (cmd) {
    case "/help":
      ui.writeLine(chalk.bold("\nAvailable commands:\n"));
      ui.writeLine("  /help             — Show this help message");
      ui.writeLine("  /model            — List available models");
      ui.writeLine("  /model <name>     — Switch to a different model");
      ui.writeLine("  /provider         — Switch provider (ollama, openai)");
      ui.writeLine("  /provider <name>  — Switch to a specific provider");
      ui.writeLine("  /clear            — Clear conversation history");
      ui.writeLine("  /tools            — List available tools");
      ui.writeLine("  /exit             — Exit the REPL");
      ui.writeLine("  /quit             — Exit the REPL");
      ui.writeLine("");
      break;

    case "/model":
      await handleModelCommand(arg, agent, ui, session, persistSession);
      break;

    case "/provider":
      await handleProviderCommand(arg, agent, ui, session, cwd, persistSession);
      break;

    case "/clear":
      agent.reset();
      ui.clearScreen();
      ui.writeLine(chalk.dim("Conversation cleared."));
      break;

    case "/tools":
      ui.writeLine(chalk.dim(`Tools: ${agent.getToolNames().join(", ")}`));
      break;

    case "/exit":
    case "/quit":
      ui.stop();
      console.log("Goodbye!");
      process.exit(0);

    default:
      ui.writeLine(chalk.yellow(`Unknown command: ${cmd}. Type /help for available commands.`));
  }
}

// -- /provider command --

async function handleProviderCommand(
  arg: string,
  agent: Agent,
  ui: TerminalUI,
  session: SessionConfig,
  cwd: string,
  persistSession: () => void,
): Promise<void> {
  if (!arg) {
    // Interactive selector
    const items: SelectorItem[] = SUPPORTED_PROVIDERS.map((p) => ({
      id: p,
      label: p,
      detail: p === "ollama" ? "Local models" : p === "openai" ? "OpenAI API" : "Anthropic Claude API",
      isActive: p === (session.provider ?? "ollama"),
    }));

    const selected = await ui.openSelector(items, { title: "Select a provider" });
    if (selected && selected !== session.provider) {
      await switchProvider(selected, agent, ui, session, cwd, persistSession);
    }
    return;
  }

  // Direct switch
  if (!SUPPORTED_PROVIDERS.includes(arg)) {
    ui.writeLine(chalk.yellow(`Unknown provider: ${arg}. Supported: ${SUPPORTED_PROVIDERS.join(", ")}`));
    return;
  }

  if (arg === session.provider) {
    ui.writeLine(chalk.dim(`Already using ${arg}.`));
    return;
  }

  await switchProvider(arg, agent, ui, session, cwd, persistSession);
}

async function switchProvider(
  providerName: string,
  agent: Agent,
  ui: TerminalUI,
  session: SessionConfig,
  _cwd: string,
  persistSession: () => void,
): Promise<void> {
  let apiKey: string | undefined;
  let baseUrl: string;

  if (providerName === "openai") {
    apiKey = session.apiKeys?.openai;
    if (!apiKey) {
      apiKey = await ui.prompt("Enter OpenAI API key:", { secret: true });
      if (!apiKey) {
        ui.writeLine(chalk.yellow("No API key provided. Provider not switched."));
        return;
      }
      session.apiKeys = { ...session.apiKeys, openai: apiKey };
    }
    baseUrl = "https://api.openai.com";
  } else if (providerName === "anthropic") {
    apiKey = session.apiKeys?.anthropic;
    if (!apiKey) {
      apiKey = await ui.prompt("Enter Anthropic API key:", { secret: true });
      if (!apiKey) {
        ui.writeLine(chalk.yellow("No API key provided. Provider not switched."));
        return;
      }
      session.apiKeys = { ...session.apiKeys, anthropic: apiKey };
    }
    baseUrl = "https://api.anthropic.com";
  } else {
    baseUrl = session.baseUrl ?? "http://localhost:11434";
  }

  try {
    const provider = createProvider({
      provider: providerName,
      apiKey,
      baseUrl,
      maxRetries: session.maxRetries,
    });

    agent.setProvider(provider, baseUrl);
    session.provider = providerName;
    session.baseUrl = baseUrl;

    // Pick model from new provider
    const modelName = await pickModel(provider, agent.getModel(), ui);
    if (modelName) {
      agent.setModel(modelName);
      agent.reset();
      session.model = modelName;

      const mode = await detectToolCallMode(modelName, baseUrl);
      const modeLabel =
        mode === ToolCallMode.NATIVE
          ? chalk.green("native tools")
          : chalk.yellow("prompt-based fallback");

      ui.writeLine(
        chalk.green(`Switched to ${providerName}/${modelName}`) +
          chalk.dim(` | Tool mode: `) +
          modeLabel +
          chalk.dim(" (conversation cleared)"),
      );
    } else {
      ui.writeLine(chalk.green(`Switched to ${providerName}`));
    }

    persistSession();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ui.writeLine(chalk.red(`Failed to switch provider: ${msg}`));
  }
}

// -- /model command --

async function handleModelCommand(
  arg: string,
  agent: Agent,
  ui: TerminalUI,
  session: SessionConfig,
  persistSession: () => void,
): Promise<void> {
  const provider = agent.getProvider();

  if (!arg) {
    // Interactive selector mode
    const modelName = await pickModel(provider, agent.getModel(), ui);
    if (modelName) {
      await switchModel(modelName, agent, ui, session, persistSession);
    }
    return;
  }

  // Direct switch by name
  try {
    const models = await provider.listModels();
    const match = models.find(
      (m) => m.name === arg || m.id === arg || m.name.startsWith(arg + ":"),
    );

    if (!match) {
      ui.writeLine(
        chalk.yellow(`Model '${arg}' not found.`) +
          chalk.dim(` Use /model to see available models.`),
      );
      return;
    }

    await switchModel(match.name, agent, ui, session, persistSession);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ui.writeLine(chalk.red(`Failed to switch model: ${msg}`));
  }
}

async function switchModel(
  modelName: string,
  agent: Agent,
  ui: TerminalUI,
  session: SessionConfig,
  persistSession: () => void,
): Promise<void> {
  agent.setModel(modelName);
  agent.reset();
  session.model = modelName;
  persistSession();

  const mode = await detectToolCallMode(modelName, agent.getBaseUrl());
  const modeLabel =
    mode === ToolCallMode.NATIVE
      ? chalk.green("native tools")
      : chalk.yellow("prompt-based fallback");

  ui.writeLine(
    chalk.green(`Switched to model: ${modelName}`) +
      chalk.dim(` | Tool mode: `) +
      modeLabel +
      chalk.dim(" (conversation cleared)"),
  );
}

// -- Shared helpers --

async function pickModel(
  provider: { listModels(): Promise<{ id: string; name: string; size?: number; quantization?: string }[]> },
  currentModel: string,
  ui: TerminalUI,
): Promise<string | null> {
  try {
    const models = await provider.listModels();

    if (models.length === 0) {
      ui.writeLine(chalk.yellow("No models found."));
      return null;
    }

    const items: SelectorItem[] = models.map((model) => {
      const isCurrent = model.name === currentModel || model.id === currentModel;
      const parts: string[] = [];
      if (model.size) parts.push(formatSize(model.size));
      if (model.quantization) parts.push(`[${model.quantization}]`);
      return {
        id: model.name,
        label: model.name,
        detail: parts.join(" "),
        isActive: isCurrent,
      };
    });

    return ui.openSelector(items, { title: "Select a model" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ui.writeLine(chalk.red(`Failed to list models: ${msg}`));
    return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
}
