import chalk from "chalk";

const ESC = "\x1b";

export interface SelectorItem {
  id: string;
  label: string;
  detail?: string;
  isActive?: boolean;
}

export interface SelectorOptions {
  title?: string;
  maxVisible?: number;
}

export type SelectorResult =
  | { type: "select"; id: string }
  | { type: "cancel" }
  | null; // key consumed but no final action

/**
 * Reusable interactive list selector — a pure state machine + renderer.
 * Does not install event listeners; the host calls `handleKey()` and `render()`.
 */
export class Selector {
  private items: SelectorItem[];
  private filtered: SelectorItem[];
  private title: string;
  private maxVisible: number;
  private selectedIdx = 0;
  private scrollOffset = 0;
  private filter = "";
  private writeFn: (s: string) => void;

  constructor(
    items: SelectorItem[],
    options: SelectorOptions,
    write: (s: string) => void,
  ) {
    this.items = items;
    this.filtered = [...items];
    this.title = options.title ?? "Select an item";
    this.maxVisible = options.maxVisible ?? 10;
    this.writeFn = write;

    // Pre-select the active item if there is one
    const activeIdx = this.filtered.findIndex((i) => i.isActive);
    if (activeIdx >= 0) {
      this.selectedIdx = activeIdx;
      this.ensureVisible();
    }
  }

  /** Process a parsed key. Returns a result action or null if the key was just consumed. */
  handleKey(key: string): SelectorResult {
    switch (key) {
      case "up":
        this.moveUp();
        return null;
      case "down":
        this.moveDown();
        return null;
      case "enter":
        if (this.filtered.length > 0) {
          return { type: "select", id: this.filtered[this.selectedIdx].id };
        }
        return null;
      case "escape":
        return { type: "cancel" };
      case "backspace":
        if (this.filter.length > 0) {
          this.filter = this.filter.slice(0, -1);
          this.applyFilter();
        }
        return null;
      default:
        // Printable character — add to filter
        if (key.length === 1 && key.charCodeAt(0) >= 32) {
          this.filter += key;
          this.applyFilter();
        }
        return null;
    }
  }

  /** Draw the selector at absolute row positions. */
  render(startRow: number, cols: number): void {
    const w = this.writeFn;

    // Title row with optional filter
    w(`${ESC}[${startRow};1H${ESC}[2K`);
    let titleText = chalk.bold(this.title);
    if (this.filter) {
      titleText += chalk.dim("  filter: ") + chalk.cyan(this.filter);
    }
    w(titleText);

    // Item rows
    const visibleCount = Math.min(this.maxVisible, this.filtered.length);
    for (let i = 0; i < this.maxVisible; i++) {
      const row = startRow + 1 + i;
      w(`${ESC}[${row};1H${ESC}[2K`);

      const itemIdx = this.scrollOffset + i;
      if (itemIdx >= this.filtered.length) continue;

      const item = this.filtered[itemIdx];
      const isSelected = itemIdx === this.selectedIdx;
      const prefix = isSelected ? " > " : "   ";
      const detail = item.detail ? "  " + item.detail : "";
      const activeSuffix = item.isActive ? chalk.green(" (active)") : "";

      let line: string;
      if (isSelected) {
        line = chalk.green.bold(prefix + item.label) + chalk.dim(detail) + activeSuffix;
      } else if (item.isActive) {
        line = chalk.green(prefix + item.label) + chalk.dim(detail) + activeSuffix;
      } else {
        line = prefix + item.label + chalk.dim(detail) + activeSuffix;
      }

      // Truncate to terminal width
      // Note: chalk formatting means visible length != string length,
      // but for safety we just let the terminal clip at the edge.
      w(line);
    }

    // "No matches" text
    if (this.filtered.length === 0) {
      const row = startRow + 1;
      w(`${ESC}[${row};1H${ESC}[2K`);
      w(chalk.dim("   No matches"));
    }
  }

  /** Erase rows occupied by the selector. */
  clear(startRow: number): void {
    const h = this.getHeight();
    for (let i = 0; i < h; i++) {
      this.writeFn(`${ESC}[${startRow + i};1H${ESC}[2K`);
    }
  }

  /** Total rows needed: 1 (title) + min(maxVisible, filtered.length) or 1 if empty. */
  getHeight(): number {
    const itemRows = this.filtered.length === 0
      ? 1
      : Math.min(this.maxVisible, this.filtered.length);
    return 1 + itemRows;
  }

  // ── Internal ──────────────────────────────────────────

  private moveUp(): void {
    if (this.filtered.length === 0) return;
    this.selectedIdx = Math.max(0, this.selectedIdx - 1);
    this.ensureVisible();
  }

  private moveDown(): void {
    if (this.filtered.length === 0) return;
    this.selectedIdx = Math.min(this.filtered.length - 1, this.selectedIdx + 1);
    this.ensureVisible();
  }

  private ensureVisible(): void {
    if (this.selectedIdx < this.scrollOffset) {
      this.scrollOffset = this.selectedIdx;
    } else if (this.selectedIdx >= this.scrollOffset + this.maxVisible) {
      this.scrollOffset = this.selectedIdx - this.maxVisible + 1;
    }
  }

  private applyFilter(): void {
    const lc = this.filter.toLowerCase();
    this.filtered = lc
      ? this.items.filter((item) => item.label.toLowerCase().includes(lc))
      : [...this.items];
    this.selectedIdx = 0;
    this.scrollOffset = 0;
  }
}
