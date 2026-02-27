# T-019: Terminal Output Rendering

## Status: Pending

## Priority: Medium

## Summary

Implement rich terminal output rendering: markdown formatting, syntax-highlighted code blocks, colored diffs, and structured tool output. This makes the agent's responses much more readable compared to dumping raw text.

## Context

LLMs frequently respond with markdown — headings, bold text, code blocks, lists, etc. In a terminal, raw markdown looks messy. We need a rendering layer that converts markdown into properly formatted terminal output with ANSI colors and formatting.

## Detailed Implementation

### Markdown Rendering

Use the `marked` library to parse markdown and a custom terminal renderer:

```typescript
import { marked } from "marked";
import chalk from "chalk";

class TerminalRenderer {
  /**
   * Render markdown text for the terminal.
   * Handles: headings, bold, italic, code (inline + blocks), lists, links, blockquotes.
   */
  renderMarkdown(text: string): string {
    // Parse markdown AST with marked
    const tokens = marked.lexer(text);
    return this.renderTokens(tokens);
  }

  private renderTokens(tokens: marked.Token[]): string {
    let output = "";
    for (const token of tokens) {
      output += this.renderToken(token);
    }
    return output;
  }

  private renderToken(token: marked.Token): string {
    switch (token.type) {
      case "heading":
        return this.renderHeading(token);
      case "paragraph":
        return this.renderParagraph(token);
      case "code":
        return this.renderCodeBlock(token);
      case "codespan":
        return this.renderInlineCode(token);
      case "list":
        return this.renderList(token);
      case "blockquote":
        return this.renderBlockquote(token);
      case "strong":
        return chalk.bold(token.text);
      case "em":
        return chalk.italic(token.text);
      case "link":
        return `${token.text} (${chalk.dim.underline(token.href)})`;
      default:
        return token.raw ?? "";
    }
  }
}
```

### Syntax Highlighting for Code Blocks

When the LLM outputs a fenced code block with a language tag (e.g., ` ```typescript `), apply syntax highlighting:

```typescript
/**
 * Simple keyword-based syntax highlighting.
 * Not a full parser — just enough to make code blocks readable.
 * Highlights: keywords, strings, comments, numbers.
 */
class SyntaxHighlighter {
  private languageKeywords: Record<string, string[]> = {
    typescript: ["const", "let", "var", "function", "class", "interface", "type", "import", "export", "from", "return", "if", "else", "for", "while", "async", "await", "new", "this", "true", "false", "null", "undefined", "try", "catch", "throw"],
    javascript: ["const", "let", "var", "function", "class", "import", "export", "from", "return", "if", "else", "for", "while", "async", "await", "new", "this", "true", "false", "null", "undefined"],
    python: ["def", "class", "import", "from", "return", "if", "elif", "else", "for", "while", "with", "as", "try", "except", "raise", "True", "False", "None", "async", "await", "self"],
    // ... more languages
  };

  highlight(code: string, language: string): string {
    const keywords = this.languageKeywords[language] ?? [];
    let result = code;

    // Highlight strings (single and double quoted)
    result = result.replace(/(["'`])(?:(?!\1).)*\1/g, (m) => chalk.green(m));

    // Highlight comments (// and #)
    result = result.replace(/(\/\/.*$|#.*$)/gm, (m) => chalk.dim(m));

    // Highlight keywords (word boundaries)
    for (const kw of keywords) {
      const regex = new RegExp(`\\b(${kw})\\b`, "g");
      result = result.replace(regex, chalk.cyan("$1"));
    }

    // Highlight numbers
    result = result.replace(/\b(\d+\.?\d*)\b/g, chalk.yellow("$1"));

    return result;
  }
}
```

### Code Block Rendering

Code blocks get a box with the language label:

```
 ┌─ typescript ──────────────────────────────┐
 │ const x = 42;                             │
 │ const message = "hello world";            │
 │                                           │
 │ function greet(name: string): string {    │
 │   return `Hello, ${name}!`;              │
 │ }                                         │
 └───────────────────────────────────────────┘
```

### Diff Rendering

When the agent edits a file, show a colored diff:

```typescript
class DiffRenderer {
  renderDiff(diffText: string): string {
    return diffText.split("\n").map(line => {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return chalk.green(line);
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        return chalk.red(line);
      }
      if (line.startsWith("@@")) {
        return chalk.cyan(line);
      }
      return line;
    }).join("\n");
  }
}
```

### Tool Output Rendering

Each tool type gets a compact, styled display:

```typescript
class ToolRenderer {
  renderToolCall(name: string, input: Record<string, unknown>): string {
    const icon = this.getToolIcon(name);
    const summary = this.summarizeInput(name, input);
    return chalk.cyan(`${icon} ${name}`) + chalk.dim(` ${summary}`);
  }

  renderToolResult(name: string, output: string, durationMs: number): string {
    const abbreviated = output.length > 300
      ? output.slice(0, 300) + chalk.dim(`... (${output.length} chars total)`)
      : output;
    return abbreviated + chalk.dim(` (${durationMs}ms)`);
  }

  private getToolIcon(name: string): string {
    // Simple ASCII icons
    const icons: Record<string, string> = {
      file_read: "[R]",
      file_write: "[W]",
      file_edit: "[E]",
      file_delete: "[D]",
      glob: "[G]",
      grep: "[S]",
      bash: "[$]",
      http_request: "[H]",
    };
    return icons[name] ?? "[?]";
  }
}
```

### Terminal Width Detection

Respect terminal width for wrapping and box drawing:

```typescript
function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}
```

### Color Support Detection

Respect `NO_COLOR` env var and detect color support:

```typescript
function supportsColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return process.stdout.isTTY ?? false;
}
```

## npm Dependencies

- `chalk` — Terminal colors (already in T-001)
- `marked` — Markdown parser

## File Locations

- `src/cli/renderer.ts` — Main rendering orchestrator
- `src/cli/markdown.ts` — Markdown-to-terminal renderer
- `src/cli/highlight.ts` — Syntax highlighter
- `src/cli/diff.ts` — Diff renderer

### Table Rendering

Markdown tables are rendered as aligned ASCII tables:

```
| Column 1  | Column 2  | Column 3 |
|-----------|-----------|----------|
| value 1   | value 2   | value 3  |
| longer    | short     | medium   |
```

Implementation: Parse the table from markdown tokens, calculate column widths, and pad each cell.

### Terminal Width Wrapping

All output respects the terminal width:

```typescript
function wrapText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;

  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length + word.length + 1 > maxWidth) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine += (currentLine ? " " : "") + word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.join("\n");
}
```

- Code blocks are NOT wrapped (they use horizontal scrolling / truncation).
- Normal text wraps at word boundaries.
- The terminal width is refreshed on each render (handles terminal resize via `process.stdout.on("resize")`).

## Acceptance Criteria

1. Markdown headings, bold, italic render with appropriate formatting.
2. Fenced code blocks render with syntax highlighting and borders.
3. Inline code renders with distinct background.
4. Lists render with proper indentation and bullets.
5. Diffs render with green/red coloring.
6. Tool outputs are compact and readable.
7. Output respects terminal width.
8. Color is disabled when `NO_COLOR` is set or stdout is not a TTY.
9. Works correctly when piped to a file (no ANSI codes).

## Dependencies

- T-001

## Blocks

- T-020 (CLI REPL uses this for all output)
