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
  private inlineSpinnerStart = 0;
  private inlineFrameWidth = 9; // visible chars: "▰▱▱  0.0s"

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
    // Hide cursor during spinner animation
    this.raw(`${ESC}[?25l`);
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
      // Show cursor again
      this.raw(`${ESC}[?25h`);
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

  /**
   * Ensure the UI is ready for user input.
   * Stops all spinners, shows cursor, and redraws the input box.
   * Call this after setRunning(false) to guarantee clean state.
   */
  ensureInputReady(): void {
    this.stopInlineSpinner();
    this.stopSpinner();
    // Always show cursor — stopInlineSpinner/stopSpinner only show it
    // when their timer was active, which is a no-op if already stopped.
    this.raw(`${ESC}[?25h`);
    this.drawInputBox();
  }

  /** Start an inline spinner at the current cursor position in the scroll region.
   *  If startTime is provided, the elapsed timer continues from that point instead of resetting. */
  startInlineSpinner(startTime?: number): void {
    this.stopInlineSpinner();
    this.inlineSpinnerIdx = 0;
    this.inlineSpinnerStart = startTime ?? Date.now();
    const bs = "\b".repeat(this.inlineFrameWidth);
    // Hide cursor so no block/rectangle appears next to the spinner
    this.raw(`${ESC}[?25l`);
    // Write first frame immediately
    this.raw(this.getInlineFrame(0) + bs);
    this.inlineSpinnerTimer = setInterval(() => {
      this.inlineSpinnerIdx += 1;
      this.raw(this.getInlineFrame(this.inlineSpinnerIdx) + bs);
    }, 100);
  }

  /** Stop the inline spinner and clear its characters. */
  stopInlineSpinner(): void {
    if (this.inlineSpinnerTimer) {
      clearInterval(this.inlineSpinnerTimer);
      this.inlineSpinnerTimer = null;
      // Erase the frame: overwrite with spaces, then backspace
      const blank = " ".repeat(this.inlineFrameWidth);
      const bs = "\b".repeat(this.inlineFrameWidth);
      this.raw(blank + bs);
      // Show cursor again
      this.raw(`${ESC}[?25h`);
    }
  }

  /** Build a single inline spinner frame — color-cycling pulse bar + elapsed time. */
  private getInlineFrame(idx: number): string {
    // Elapsed time (fixed 5-char width)
    const elapsed = (Date.now() - this.inlineSpinnerStart) / 1000;
    const timeStr = elapsed < 100
      ? elapsed.toFixed(1) + "s"
      : Math.floor(elapsed) + "s";
    const timePart = chalk.dim(timeStr.padStart(5));

    // Color-cycling bar (3 chars)
    const bar = (filled: number, color: (s: string) => string): string => {
      const on = "▰".repeat(filled);
      const off = "▱".repeat(3 - filled);
      return filled === 3 ? color(on) : color(on) + chalk.dim(off);
    };

    const phase = idx % 12;
    let barStr: string;
    switch (phase) {
      case 0:  barStr = bar(1, chalk.green); break;
      case 1:  barStr = bar(2, chalk.green); break;
      case 2:  barStr = bar(3, chalk.greenBright); break;
      case 3:  barStr = bar(3, chalk.cyanBright); break;
      case 4:  barStr = bar(2, chalk.cyan); break;
      case 5:  barStr = bar(1, chalk.cyan); break;
      case 6:  barStr = chalk.dim("▱▱▱"); break;
      case 7:  barStr = bar(1, chalk.magenta); break;
      case 8:  barStr = bar(2, chalk.magenta); break;
      case 9:  barStr = bar(3, chalk.magentaBright); break;
      case 10: barStr = bar(2, chalk.magenta); break;
      case 11: barStr = chalk.dim("▱▱▱"); break;
      default: barStr = chalk.dim("▱▱▱"); break;
    }

    return barStr + " " + timePart;
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
      if (this.spinnerTimer) {
        const frame = this.spinnerFrames[this.spinnerIdx];
        this.raw(chalk.yellow(` ${frame} ${this.statusText}`));
      } else {
        this.raw(chalk.dim(`  ${this.statusText}`));
      }
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
