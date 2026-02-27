import chalk from "chalk";
import type { Agent, AgentEvent } from "../agent/agent.js";
import { TerminalUI } from "./terminal-ui.js";
import { Renderer } from "./renderer.js";
import { detectToolCallMode, ToolCallMode } from "../providers/tool-capability.js";

interface ReplOptions {
  agent: Agent;
  providerName: string;
  modelName: string;
}

export async function startRepl(options: ReplOptions): Promise<never> {
  const { agent, providerName } = options;

  let running = false;

  const ui = new TerminalUI({
    onSubmit: (text) => {
      handleSubmit(text).catch((err) => {
        ui.stopSpinner();
        ui.setRunning(false);
        running = false;
        renderer.renderError(err instanceof Error ? err : new Error(String(err)));
      });
    },
    onInterrupt: () => {
      if (running) {
        // TODO: abort the agent run via AbortController
        ui.stopInlineSpinner();
        ui.writeLine(chalk.yellow("[Cancelled]"));
        ui.stopSpinner();
        ui.setRunning(false);
        running = false;
      } else {
        ui.stop();
        console.log("Goodbye!");
        process.exit(0);
      }
    },
  });

  const renderer = new Renderer(ui);

  ui.start();

  // Banner
  ui.writeLine(chalk.bold.cyan("  ollama-claude v0.1.0"));
  ui.writeLine(chalk.cyan(`  Provider: ${providerName} | Model: ${agent.getModel()}`));
  ui.writeLine(chalk.dim("  Type /help for commands\n"));

  async function handleSubmit(text: string): Promise<void> {
    if (running) return;

    // Show what the user typed in the output area
    ui.writeLine(chalk.bold.green("> ") + text);

    // Slash commands
    if (text.startsWith("/")) {
      await handleSlashCommand(text, agent, ui, renderer);
      return;
    }

    // Run agent
    running = true;
    ui.setRunning(true);
    ui.startSpinner("Thinking...");
    ui.writeLine(""); // blank line before response

    let firstTextChunk = true;
    ui.startInlineSpinner();

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
            ui.startInlineSpinner();
            break;

          case "turn_complete":
            break;

          case "loop_complete":
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
    ui.writeLine(""); // blank line after response
    ui.stopSpinner();
    ui.setRunning(false);
    running = false;
  }

  // Block forever — process exits via Ctrl+C/Ctrl+D or /exit
  return new Promise<never>(() => {});
}

async function handleSlashCommand(
  input: string,
  agent: Agent,
  ui: TerminalUI,
  renderer: Renderer,
): Promise<void> {
  const parts = input.split(/\s+/);
  const cmd = parts[0];
  const arg = parts.slice(1).join(" ");

  switch (cmd) {
    case "/help":
      ui.writeLine(chalk.bold("\nAvailable commands:\n"));
      ui.writeLine("  /help           — Show this help message");
      ui.writeLine("  /model          — List available models");
      ui.writeLine("  /model <name>   — Switch to a different model");
      ui.writeLine("  /clear          — Clear conversation history");
      ui.writeLine("  /tools          — List available tools");
      ui.writeLine("  /exit           — Exit the REPL");
      ui.writeLine("  /quit           — Exit the REPL");
      ui.writeLine("");
      break;

    case "/model":
      await handleModelCommand(arg, agent, ui);
      break;

    case "/clear":
      agent.reset();
      ui.writeLine(chalk.dim("Conversation cleared."));
      break;

    case "/tools":
      ui.writeLine(chalk.dim("Tools: file_read, bash"));
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

async function handleModelCommand(arg: string, agent: Agent, ui: TerminalUI): Promise<void> {
  const provider = agent.getProvider();

  if (!arg) {
    ui.writeLine(chalk.dim("\nFetching models...\n"));

    try {
      const models = await provider.listModels();

      if (models.length === 0) {
        ui.writeLine(chalk.yellow("No models found. Run `ollama pull <model>` to download one."));
        return;
      }

      const current = agent.getModel();
      ui.writeLine(chalk.bold("Available models:\n"));

      for (const model of models) {
        const isCurrent = model.name === current || model.id === current;
        const marker = isCurrent ? chalk.green(" (active)") : "";
        const size = model.size ? chalk.dim(` (${formatSize(model.size)})`) : "";
        const quant = model.quantization ? chalk.dim(` [${model.quantization}]`) : "";
        const name = isCurrent ? chalk.green(model.name) : model.name;
        ui.writeLine(`  ${name}${size}${quant}${marker}`);
      }

      ui.writeLine(chalk.dim("\nUsage: /model <name> to switch"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ui.writeLine(chalk.red(`Failed to list models: ${msg}`));
    }

    return;
  }

  try {
    const models = await provider.listModels();
    const match = models.find(
      (m) => m.name === arg || m.id === arg || m.name.startsWith(arg + ":"),
    );

    if (!match) {
      ui.writeLine(
        chalk.yellow(`Model '${arg}' not found locally.`) +
          chalk.dim(` Run \`ollama pull ${arg}\` to download it.`),
      );
      ui.writeLine(chalk.dim("Use /model to see available models."));
      return;
    }

    const modelName = match.name;
    agent.setModel(modelName);
    agent.reset();

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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ui.writeLine(chalk.red(`Failed to switch model: ${msg}`));
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
}
