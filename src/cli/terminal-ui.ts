import chalk from "chalk";
import { Selector, type SelectorItem, type SelectorOptions } from "./selector.js";

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

enum InputMode {
  NORMAL,
  SELECTOR,
}

/**
 * Terminal UI with a scrolling output area and fixed bordered input box at the bottom.
 *
 * Layout (NORMAL mode):
 *   Row 1..H-4  — Scroll region (output from agent, tool calls, etc.)
 *   Row H-3     — ──────────────── (input top rule)
 *   Row H-2     — > user input█
 *   Row H-1     — ──────────────── (input bottom rule)
 *   Row H       — Status line (spinner + status text)
 *
 * Layout (SELECTOR mode):
 *   Row 1..S    — Scroll region (shrunk)
 *   Row S+1     — Selector title
 *   Row S+2..   — Selector items
 *   Row H-3     — ──────────────── (input top rule)
 *   Row H-2     — > /model█
 *   Row H-1     — ──────────────── (input bottom rule)
 *   Row H       — Status line
 *
 * Uses alternate screen buffer so the user's terminal is restored on exit.
 */
export class TerminalUI {
  private rows = 0;
  private cols = 0;
  private inputBuffer = "";
  private statusText = "";
  private running = false;

  // Input mode state machine
  private inputMode = InputMode.NORMAL;

  // Selector overlay
  private selector: Selector | null = null;
  private selectorResolve: ((id: string | null) => void) | null = null;

  // Ghost text autocomplete
  private ghostText = "";
  private completions: string[] = [];

  // Inline spinner (in scroll region, where text will appear)
  private inlineSpinnerTimer: ReturnType<typeof setInterval> | null = null;
  private inlineSpinnerIdx = 0;
  private inlineSpinnerStart = 0;
  private inlineFrameWidth = 9; // visible chars: "▰▱▱  0.0s"

  // Bottom bar height: status + 3 lines for bordered input box
  private static BOTTOM_HEIGHT = 4;
  // Minimum terminal dimensions to prevent layout breakage
  private static MIN_ROWS = 8;
  private static MIN_COLS = 20;

  // Callbacks
  private onSubmit: (input: string) => void;
  private onInterrupt: () => void;

  constructor(options: { onSubmit: (input: string) => void; onInterrupt: () => void }) {
    this.onSubmit = options.onSubmit;
    this.onInterrupt = options.onInterrupt;
  }

  start(): void {
    this.rows = Math.max(TerminalUI.MIN_ROWS, process.stdout.rows ?? 24);
    this.cols = Math.max(TerminalUI.MIN_COLS, process.stdout.columns ?? 80);

    // Alternate screen buffer
    this.raw(`${ESC}[?1049h`);
    // Clear screen
    this.raw(`${ESC}[2J`);
    // Set scroll region
    this.applyScrollRegion();
    // Draw the fixed bottom bar
    this.drawBottomBar();
    // Position cursor at bottom of scroll region so content appears
    // right above the input box (chat-style, growing upward)
    this.moveCursorToScrollBottom();

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
    // Ensure cursor is within the scroll region before writing
    this.raw(text);
  }

  /** Write a complete line into the scrolling output area. */
  writeLine(text: string): void {
    this.write(text + "\n");
  }

  /** Get current terminal width (useful for renderers that need to wrap/truncate). */
  getWidth(): number {
    return this.cols;
  }

  /** Get current terminal height. */
  getRows(): number {
    return this.rows;
  }

  /** No-op kept for API compatibility. Status line always shows persistent info. */
  startSpinner(_text: string): void {
    // Hide cursor while agent is working
    this.raw(`${ESC}[?25l`);
  }

  /** No-op kept for API compatibility. */
  stopSpinner(): void {
    // Show cursor again
    this.raw(`${ESC}[?25h`);
  }

  /** Update the persistent status line (model, directory, tokens). */
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
    this.drawStatusLine();
    this.drawInputBox();
  }

  /** Set the list of completions for ghost text (e.g. slash commands). */
  setCompletions(list: string[]): void {
    this.completions = list;
  }

  /**
   * Open an interactive selector overlay above the input box.
   * Returns the selected item id, or null if cancelled.
   */
  openSelector(items: SelectorItem[], options?: SelectorOptions): Promise<string | null> {
    return new Promise((resolve) => {
      this.selector = new Selector(items, options ?? {}, (s) => this.raw(s));
      this.selectorResolve = resolve;
      this.inputMode = InputMode.SELECTOR;
      this.renderSelector();
    });
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
    const selectorHeight = this.inputMode === InputMode.SELECTOR && this.selector
      ? this.selector.getHeight()
      : 0;
    const scrollEnd = Math.max(1, this.rows - TerminalUI.BOTTOM_HEIGHT - selectorHeight);
    this.raw(`${ESC}[1;${scrollEnd}r`);
  }

  /** Move cursor to the last row of the scroll region, column 1.
   *  This makes new output appear right above the input box. */
  private moveCursorToScrollBottom(): void {
    const selectorHeight = this.inputMode === InputMode.SELECTOR && this.selector
      ? this.selector.getHeight()
      : 0;
    const scrollEnd = Math.max(1, this.rows - TerminalUI.BOTTOM_HEIGHT - selectorHeight);
    this.raw(`${ESC}[${scrollEnd};1H`);
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

  /** Write the input area (3 rows: top rule, input, bottom rule). Caller must save/restore cursor. */
  private drawInputBox_raw(): void {
    const w = this.cols;

    // Top rule — row H-3
    const topRow = this.rows - 3;
    this.raw(`${ESC}[${topRow};1H${ESC}[2K`);
    this.raw(chalk.dim(BOX.horizontal.repeat(Math.min(w, this.cols))));

    // Input content — row H-2
    const midRow = this.rows - 2;
    this.raw(`${ESC}[${midRow};1H${ESC}[2K`);
    const promptPrefix = "> ";
    const cursor = this.running ? " " : "█";
    const ghost = !this.running && this.ghostText ? chalk.dim.gray(this.ghostText) : "";
    const content = this.inputBuffer + cursor + ghost;
    const maxContent = Math.max(0, w - promptPrefix.length);
    const visible = content.length > maxContent
      ? content.slice(content.length - maxContent)
      : content;
    this.raw(chalk.bold.green(promptPrefix) + visible);

    // Bottom rule — row H-1
    const botRow = this.rows - 1;
    this.raw(`${ESC}[${botRow};1H${ESC}[2K`);
    this.raw(chalk.dim(BOX.horizontal.repeat(Math.min(w, this.cols))));
  }

  /** Write status line below the input box. Caller must save/restore cursor. */
  private drawStatusLine_raw(): void {
    const row = this.rows;
    this.raw(`${ESC}[${row};1H${ESC}[2K`);
    if (this.statusText) {
      // Truncate to terminal width to prevent wrapping
      const text = `  ${this.statusText}`;
      const visible = text.length > this.cols ? text.slice(0, this.cols) : text;
      this.raw(chalk.dim(visible));
    }
  }

  // ── Key handling ──────────────────────────────────────────

  private onKeypress = (data: string): void => {
    // Parse escape sequences into named keys
    if (data.length > 1 && data.charCodeAt(0) === 27) {
      // ESC [ <letter> — standard arrow keys and common sequences
      if (data === `${ESC}[A`) { this.handleParsedKey("up"); return; }
      if (data === `${ESC}[B`) { this.handleParsedKey("down"); return; }
      if (data === `${ESC}[C`) { this.handleParsedKey("right"); return; }
      if (data === `${ESC}[D`) { this.handleParsedKey("left"); return; }
      // Unknown escape sequence — ignore
      return;
    }

    // Single ESC character
    if (data.length === 1 && data.charCodeAt(0) === 27) {
      this.handleParsedKey("escape");
      return;
    }

    for (const ch of data) {
      const code = ch.charCodeAt(0);

      if (code === 9) {
        this.handleParsedKey("tab");
      } else if (code === 13) {
        this.handleParsedKey("enter");
      } else if (code === 127 || code === 8) {
        this.handleParsedKey("backspace");
      } else if (code === 3) {
        // Ctrl+C — always handle directly
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
        // Ctrl+L — full redraw (also re-reads terminal size)
        this.rows = Math.max(TerminalUI.MIN_ROWS, process.stdout.rows ?? 24);
        this.cols = Math.max(TerminalUI.MIN_COLS, process.stdout.columns ?? 80);
        this.raw(`${ESC}[2J`);
        this.applyScrollRegion();
        this.drawBottomBar();
        this.moveCursorToScrollBottom();
      } else if (code >= 32) {
        this.handleParsedKey(ch);
      }
    }
  };

  private handleParsedKey(key: string): void {
    if (this.inputMode === InputMode.SELECTOR) {
      this.handleSelectorKey(key);
    } else {
      this.handleNormalKey(key);
    }
  }

  private handleNormalKey(key: string): void {
    switch (key) {
      case "enter": {
        const text = this.inputBuffer;
        this.inputBuffer = "";
        this.ghostText = "";
        this.drawInputBox();
        if (text.trim()) {
          this.onSubmit(text.trim());
        }
        break;
      }
      case "backspace":
        if (this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this.updateGhostText();
          this.drawInputBox();
        }
        break;
      case "tab":
        if (this.ghostText) {
          this.inputBuffer += this.ghostText;
          this.ghostText = "";
          this.drawInputBox();
        }
        break;
      case "escape":
        if (this.ghostText) {
          this.ghostText = "";
          this.drawInputBox();
        }
        break;
      case "up":
      case "down":
      case "left":
      case "right":
        // Arrow keys in normal mode — ignore for now
        break;
      default:
        // Printable character
        if (!this.running && key.length === 1) {
          this.inputBuffer += key;
          this.updateGhostText();
          this.drawInputBox();
        }
        break;
    }
  }

  private handleSelectorKey(key: string): void {
    if (!this.selector) return;

    const result = this.selector.handleKey(key);

    if (result) {
      // Final action — dismiss selector
      const id = result.type === "select" ? result.id : null;
      this.dismissSelector();
      this.selectorResolve?.(id);
      this.selectorResolve = null;
    } else {
      // Key consumed — re-render selector
      this.renderSelector();
    }
  }

  // ── Ghost text ──────────────────────────────────────────

  private updateGhostText(): void {
    this.ghostText = "";
    const buf = this.inputBuffer;
    if (!buf.startsWith("/") || buf.length === 0) return;

    const lc = buf.toLowerCase();
    for (const completion of this.completions) {
      if (completion.toLowerCase().startsWith(lc) && completion.length > buf.length) {
        this.ghostText = completion.slice(buf.length);
        return;
      }
    }
  }

  // ── Selector overlay ──────────────────────────────────────

  private renderSelector(): void {
    if (!this.selector) return;

    // Shrink scroll region to make room for the selector
    this.applyScrollRegion();

    const selectorHeight = this.selector.getHeight();
    const selectorStartRow = this.rows - TerminalUI.BOTTOM_HEIGHT - selectorHeight + 1;

    this.raw(`${ESC}7`); // save cursor
    this.selector.render(selectorStartRow, this.cols);
    this.drawInputBox_raw();
    this.drawStatusLine_raw();
    this.raw(`${ESC}8`); // restore cursor
  }

  private dismissSelector(): void {
    if (!this.selector) return;

    const selectorHeight = this.selector.getHeight();
    const selectorStartRow = this.rows - TerminalUI.BOTTOM_HEIGHT - selectorHeight + 1;

    this.raw(`${ESC}7`); // save cursor
    this.selector.clear(selectorStartRow);
    this.raw(`${ESC}8`); // restore cursor

    this.selector = null;
    this.inputMode = InputMode.NORMAL;

    // Restore full scroll region
    this.applyScrollRegion();
    this.drawBottomBar();
    this.moveCursorToScrollBottom();
  }

  private onResize = (): void => {
    this.rows = Math.max(TerminalUI.MIN_ROWS, process.stdout.rows ?? 24);
    this.cols = Math.max(TerminalUI.MIN_COLS, process.stdout.columns ?? 80);

    // Dismiss selector on resize to avoid layout corruption
    if (this.inputMode === InputMode.SELECTOR && this.selector) {
      this.selector = null;
      this.inputMode = InputMode.NORMAL;
      this.selectorResolve?.(null);
      this.selectorResolve = null;
    }

    // Pause inline spinner during redraw (will be restarted after)
    const hadInlineSpinner = this.inlineSpinnerTimer !== null;
    const savedSpinnerStart = this.inlineSpinnerStart;
    if (hadInlineSpinner) {
      clearInterval(this.inlineSpinnerTimer!);
      this.inlineSpinnerTimer = null;
    }

    // Full redraw: clear screen, reapply layout, redraw fixed areas
    this.raw(`${ESC}[2J`);          // clear entire alternate screen
    this.applyScrollRegion();
    this.drawBottomBar();
    this.moveCursorToScrollBottom();

    // Resume inline spinner if it was active
    if (hadInlineSpinner) {
      this.startInlineSpinner(savedSpinnerStart);
    }
  };

  private raw(text: string): void {
    process.stdout.write(text);
  }
}
