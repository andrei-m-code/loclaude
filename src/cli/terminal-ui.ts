import chalk from "chalk";

const ESC = "\x1b";

// Box-drawing characters
const BOX = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
};

/**
 * Terminal UI with a scrolling output area and fixed bordered input box at the bottom.
 *
 * Layout:
 *   Row 1..H-4  — Scroll region (output from agent, tool calls, etc.)
 *   Row H-3     — Status line (spinner + status text)
 *   Row H-2     — ┌──────────────────────────┐
 *   Row H-1     — │ > user input█            │
 *   Row H       — └──────────────────────────┘
 *
 * Uses alternate screen buffer so the user's terminal is restored on exit.
 */
export class TerminalUI {
  private rows = 0;
  private cols = 0;
  private inputBuffer = "";
  private statusText = "";
  private running = false;

  // Status bar spinner
  private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private spinnerIdx = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  // Inline spinner (in scroll region, where text will appear)
  private inlineSpinnerTimer: ReturnType<typeof setInterval> | null = null;
  private inlineSpinnerIdx = 0;

  // Bottom bar height: status + 3 lines for bordered input box
  private static BOTTOM_HEIGHT = 4;

  // Callbacks
  private onSubmit: (input: string) => void;
  private onInterrupt: () => void;

  constructor(options: { onSubmit: (input: string) => void; onInterrupt: () => void }) {
    this.onSubmit = options.onSubmit;
    this.onInterrupt = options.onInterrupt;
  }

  start(): void {
    this.rows = process.stdout.rows ?? 24;
    this.cols = process.stdout.columns ?? 80;

    // Alternate screen buffer
    this.raw(`${ESC}[?1049h`);
    // Clear screen
    this.raw(`${ESC}[2J`);
    // Set scroll region
    this.applyScrollRegion();
    // Move cursor to top-left of scroll region
    this.raw(`${ESC}[1;1H`);
    // Draw the fixed bottom bar
    this.drawBottomBar();
    // Cursor back into scroll region
    this.raw(`${ESC}[1;1H`);

    // Raw mode for keystroke handling
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.onKeypress);
    process.stdout.on("resize", this.onResize);
  }

  stop(): void {
    this.stopSpinner();
    this.stopInlineSpinner();
    process.stdin.removeListener("data", this.onKeypress);
    process.stdout.removeListener("resize", this.onResize);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    // Show cursor, reset scroll region, exit alternate screen
    this.raw(`${ESC}[?25h`);
    this.raw(`${ESC}[r`);
    this.raw(`${ESC}[?1049l`);
  }

  /** Write text into the scrolling output area. Supports partial writes (streaming). */
  write(text: string): void {
    this.raw(text);
  }

  /** Write a complete line into the scrolling output area. */
  writeLine(text: string): void {
    this.write(text + "\n");
  }

  /** Show an animated spinner with the given status text. */
  startSpinner(text: string): void {
    this.statusText = text;
    this.spinnerIdx = 0;
    this.drawStatusLine();
    this.stopSpinner();
    this.spinnerTimer = setInterval(() => {
      this.spinnerIdx = (this.spinnerIdx + 1) % this.spinnerFrames.length;
      this.drawStatusLine();
    }, 80);
  }

  /** Stop the spinner and clear the status line. */
  stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    this.statusText = "";
    this.drawStatusLine();
  }

  /** Update spinner text without resetting animation. */
  setStatus(text: string): void {
    this.statusText = text;
    this.drawStatusLine();
  }

  setRunning(value: boolean): void {
    this.running = value;
  }

  /** Start an inline spinner at the current cursor position in the scroll region. */
  startInlineSpinner(): void {
    this.stopInlineSpinner();
    this.inlineSpinnerIdx = 0;
    // Write first frame immediately
    const first = chalk.dim(this.spinnerFrames[0]);
    this.raw(`${first}\b`);
    this.inlineSpinnerTimer = setInterval(() => {
      this.inlineSpinnerIdx = (this.inlineSpinnerIdx + 1) % this.spinnerFrames.length;
      const frame = chalk.dim(this.spinnerFrames[this.inlineSpinnerIdx]);
      this.raw(`${frame}\b`);
    }, 80);
  }

  /** Stop the inline spinner and clear its character. */
  stopInlineSpinner(): void {
    if (this.inlineSpinnerTimer) {
      clearInterval(this.inlineSpinnerTimer);
      this.inlineSpinnerTimer = null;
      this.raw(" \b"); // clear the spinner character
    }
  }

  // ── Private ──────────────────────────────────────────────

  private applyScrollRegion(): void {
    const scrollEnd = Math.max(1, this.rows - TerminalUI.BOTTOM_HEIGHT);
    this.raw(`${ESC}[1;${scrollEnd}r`);
  }

  private drawBottomBar(): void {
    this.raw(`${ESC}7`);
    this.drawStatusLine_raw();
    this.drawInputBox_raw();
    this.raw(`${ESC}8`);
  }

  private drawStatusLine(): void {
    this.raw(`${ESC}7`);
    this.drawStatusLine_raw();
    this.raw(`${ESC}8`);
  }

  private drawInputBox(): void {
    this.raw(`${ESC}7`);
    this.drawInputBox_raw();
    this.raw(`${ESC}8`);
  }

  /** Write status line. Caller must save/restore cursor. */
  private drawStatusLine_raw(): void {
    const row = this.rows - 3;
    this.raw(`${ESC}[${row};1H${ESC}[2K`);
    if (this.statusText) {
      const frame = this.spinnerTimer ? this.spinnerFrames[this.spinnerIdx] : "●";
      this.raw(chalk.yellow(` ${frame} ${this.statusText}`));
    }
  }

  /** Write the bordered input box (3 rows). Caller must save/restore cursor. */
  private drawInputBox_raw(): void {
    const w = this.cols;
    const innerW = Math.max(1, w - 2); // width inside the box

    // Top border — row H-2
    const topRow = this.rows - 2;
    this.raw(`${ESC}[${topRow};1H${ESC}[2K`);
    this.raw(chalk.dim(BOX.topLeft + BOX.horizontal.repeat(innerW) + BOX.topRight));

    // Input content — row H-1
    const midRow = this.rows - 1;
    this.raw(`${ESC}[${midRow};1H${ESC}[2K`);
    const cursor = this.running ? " " : "█";
    const content = this.inputBuffer + cursor;
    // Visible space: innerW minus 2 for "> " prompt
    const maxContent = Math.max(0, innerW - 2);
    const visible = content.length > maxContent
      ? content.slice(content.length - maxContent)
      : content;
    const padding = Math.max(0, maxContent - visible.length);
    this.raw(
      chalk.dim(BOX.vertical) +
        chalk.bold.green("> ") +
        visible +
        " ".repeat(padding) +
        chalk.dim(BOX.vertical),
    );

    // Bottom border — row H
    const botRow = this.rows;
    this.raw(`${ESC}[${botRow};1H${ESC}[2K`);
    this.raw(chalk.dim(BOX.bottomLeft + BOX.horizontal.repeat(innerW) + BOX.bottomRight));
  }

  private onKeypress = (data: string): void => {
    // Skip escape sequences (arrow keys, function keys, etc.)
    if (data.length > 1 && data.charCodeAt(0) === 27) return;

    for (const ch of data) {
      const code = ch.charCodeAt(0);

      if (code === 13) {
        // Enter
        const text = this.inputBuffer;
        this.inputBuffer = "";
        this.drawInputBox();
        if (text.trim()) {
          this.onSubmit(text.trim());
        }
      } else if (code === 127 || code === 8) {
        // Backspace
        if (this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this.drawInputBox();
        }
      } else if (code === 3) {
        // Ctrl+C
        this.onInterrupt();
      } else if (code === 4) {
        // Ctrl+D — exit
        this.stop();
        process.exit(0);
      } else if (code === 26) {
        // Ctrl+Z — suspend / exit to regular terminal
        this.stop();
        process.exit(0);
      } else if (code === 12) {
        // Ctrl+L — redraw
        this.raw(`${ESC}[2J`);
        this.applyScrollRegion();
        this.raw(`${ESC}[1;1H`);
        this.drawBottomBar();
        this.raw(`${ESC}[1;1H`);
      } else if (code >= 32) {
        if (!this.running) {
          this.inputBuffer += ch;
          this.drawInputBox();
        }
      }
    }
  };

  private onResize = (): void => {
    this.rows = process.stdout.rows ?? 24;
    this.cols = process.stdout.columns ?? 80;
    this.applyScrollRegion();
    this.drawBottomBar();
  };

  private raw(text: string): void {
    process.stdout.write(text);
  }
}
