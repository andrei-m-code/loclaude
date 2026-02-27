import chalk from "chalk";

const ESC = "\x1b";

/**
 * Terminal UI with a scrolling output area and fixed input bar at the bottom.
 *
 * Layout:
 *   Row 1..H-2  — Scroll region (output from agent, tool calls, etc.)
 *   Row H-1     — Status line (spinner + status text)
 *   Row H       — Input line ("> " prompt + user input + cursor)
 *
 * Uses alternate screen buffer so the user's terminal is restored on exit.
 */
export class TerminalUI {
  private rows = 0;
  private cols = 0;
  private inputBuffer = "";
  private statusText = "";
  private running = false;

  // Spinner
  private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private spinnerIdx = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

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
    // Cursor is in the scroll region — just write. Auto-scrolls when it hits the bottom.
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
    this.stopSpinner(); // clear any existing timer
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

  // ── Private ──────────────────────────────────────────────

  private applyScrollRegion(): void {
    const scrollEnd = Math.max(1, this.rows - 2);
    this.raw(`${ESC}[1;${scrollEnd}r`);
  }

  private drawBottomBar(): void {
    // Save cursor position (inside scroll region)
    this.raw(`${ESC}7`);
    this.drawStatusLine_raw();
    this.drawInputLine_raw();
    // Restore cursor back to scroll region
    this.raw(`${ESC}8`);
  }

  private drawStatusLine(): void {
    this.raw(`${ESC}7`);
    this.drawStatusLine_raw();
    this.raw(`${ESC}8`);
  }

  private drawInputLine(): void {
    this.raw(`${ESC}7`);
    this.drawInputLine_raw();
    this.raw(`${ESC}8`);
  }

  /** Write status line at row H-1. Caller must save/restore cursor. */
  private drawStatusLine_raw(): void {
    const row = this.rows - 1;
    this.raw(`${ESC}[${row};1H${ESC}[2K`);
    if (this.statusText) {
      const frame = this.spinnerTimer ? this.spinnerFrames[this.spinnerIdx] : "●";
      this.raw(chalk.yellow(` ${frame} ${this.statusText}`));
    }
  }

  /** Write input line at row H. Caller must save/restore cursor. */
  private drawInputLine_raw(): void {
    const row = this.rows;
    this.raw(`${ESC}[${row};1H${ESC}[2K`);
    this.raw(chalk.bold.green("> ") + this.inputBuffer + chalk.dim("█"));
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
        this.drawInputLine();
        if (text.trim()) {
          this.onSubmit(text.trim());
        }
      } else if (code === 127 || code === 8) {
        // Backspace
        if (this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this.drawInputLine();
        }
      } else if (code === 3) {
        // Ctrl+C
        this.onInterrupt();
      } else if (code === 4) {
        // Ctrl+D — exit
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
        // Don't accept typing while agent is running (except the above controls)
        if (!this.running) {
          this.inputBuffer += ch;
          this.drawInputLine();
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
