# T-021: Safety, Sandboxing, and Permission System

## Status: Pending

## Priority: High

## Summary

Implement a permission and safety system that controls what the agent is allowed to do. This includes confirming dangerous operations with the user, blocking obviously destructive commands, restricting file access to the project directory, and providing an audit trail of all tool executions.

## Context

An autonomous agent with shell access and file system permissions is powerful but dangerous. Without safety mechanisms:
- A confused LLM could `rm -rf /` or delete the user's source code.
- It could run `git push --force` and overwrite the remote.
- It could read sensitive files (`.env`, SSH keys, credentials).
- It could make unwanted network requests.

We need layered safety: some things are always blocked, some require confirmation, and some are freely allowed.

## Detailed Implementation

### Permission Levels

```typescript
enum PermissionLevel {
  /** Always allowed — no confirmation needed */
  ALLOW = "allow",
  /** Requires user confirmation before execution */
  CONFIRM = "confirm",
  /** Always blocked — agent cannot do this */
  DENY = "deny",
}
```

### Permission Categories

| Category | Default | Examples |
|----------|---------|---------|
| File Read (inside project) | ALLOW | Reading source files |
| File Read (outside project) | CONFIRM | Reading `/etc/hosts`, `~/.ssh/config` |
| File Write (inside project) | ALLOW | Creating/editing source files |
| File Write (outside project) | CONFIRM | Writing to `/tmp`, home dir |
| File Delete | CONFIRM | Any file deletion |
| Bash (safe commands) | ALLOW | `ls`, `cat`, `git status`, `npm test` |
| Bash (mutating commands) | CONFIRM | `git commit`, `npm install`, `rm` |
| Bash (dangerous commands) | DENY | `rm -rf /`, `mkfs`, fork bombs |
| HTTP (public internet) | ALLOW | External API calls |
| HTTP (private networks) | DENY | Localhost, internal IPs |

### Permission Manager

```typescript
class PermissionManager {
  private projectRoot: string;
  private mode: "auto" | "confirm-all" | "yolo";
  private rememberedDecisions: Map<string, PermissionLevel> = new Map();

  constructor(projectRoot: string, mode: "auto" | "confirm-all" | "yolo" = "auto") {
    this.projectRoot = path.resolve(projectRoot);
    this.mode = mode;
  }

  /**
   * Check if a tool action is allowed.
   * Returns: "allow" (proceed), "confirm" (ask user), or "deny" (block).
   */
  async check(action: ToolAction): Promise<PermissionLevel> {
    // "yolo" mode = everything allowed (for experienced users)
    if (this.mode === "yolo") return PermissionLevel.ALLOW;

    // Check for hard denials first (always blocked regardless of mode)
    if (this.isHardDenied(action)) return PermissionLevel.DENY;

    // "confirm-all" mode = confirm everything except hard denials
    if (this.mode === "confirm-all") return PermissionLevel.CONFIRM;

    // "auto" mode = smart permission checking
    return this.autoCheck(action);
  }

  private isHardDenied(action: ToolAction): boolean {
    switch (action.type) {
      case "bash":
        return this.isDangerousBashCommand(action.command);
      case "file_write":
      case "file_delete":
        return this.isProtectedPath(action.path);
      case "http":
        return false; // Handled by the HTTP tool's own SSRF protection
      default:
        return false;
    }
  }

  private autoCheck(action: ToolAction): PermissionLevel {
    switch (action.type) {
      case "file_read":
        return this.isInsideProject(action.path)
          ? PermissionLevel.ALLOW
          : PermissionLevel.CONFIRM;

      case "file_write":
        return this.isInsideProject(action.path)
          ? PermissionLevel.ALLOW
          : PermissionLevel.CONFIRM;

      case "file_edit":
        return this.isInsideProject(action.path)
          ? PermissionLevel.ALLOW
          : PermissionLevel.CONFIRM;

      case "file_delete":
        return PermissionLevel.CONFIRM; // Always confirm deletes

      case "bash":
        return this.classifyBashCommand(action.command);

      case "glob":
      case "grep":
        return PermissionLevel.ALLOW; // Read-only search

      case "http":
        return PermissionLevel.ALLOW; // SSRF handled by tool

      default:
        return PermissionLevel.CONFIRM;
    }
  }

  /**
   * Classify bash commands by risk level.
   */
  private classifyBashCommand(command: string): PermissionLevel {
    // Always safe (read-only, informational)
    const safePatterns = [
      /^ls\b/, /^cat\b/, /^head\b/, /^tail\b/, /^wc\b/,
      /^echo\b/, /^printf\b/, /^pwd$/, /^whoami$/,
      /^git\s+(status|log|diff|show|branch|remote)\b/,
      /^git\s+stash\s+list\b/,
      /^node\s+--version/, /^npm\s+--version/, /^pnpm\s+--version/,
      /^which\b/, /^type\b/, /^file\b/, /^stat\b/,
      /^find\b/, /^grep\b/, /^rg\b/,
      /^tree\b/, /^du\b/, /^df\b/,
      /^env$/, /^printenv\b/,
    ];

    for (const pattern of safePatterns) {
      if (pattern.test(command.trim())) return PermissionLevel.ALLOW;
    }

    // Dangerous (always blocked)
    const dangerousPatterns = [
      /rm\s+(-rf|-fr)\s+\//,           // rm -rf with root path
      /rm\s+(-rf|-fr)\s+~/,            // rm -rf home
      /mkfs\b/,                         // Format filesystem
      /dd\s+if=.*of=\/dev\//,          // Raw disk write
      /:\(\)\{\s*:\|:&\s*\}/,          // Fork bomb
      />\s*\/dev\/sd/,                  // Write to raw device
      /git\s+push\s+.*--force/,        // Force push
      /sudo\s+rm\b/,                   // Sudo remove
      /\brm\s+-[a-z]*r[a-z]*f/,           // rm with -rf in any flag order
      /\bchmod\s+777\b/,                   // World-writable permissions
      /\bchown\b/,                         // Change file ownership
      /\bcurl\b.*\|\s*(ba)?sh/,            // Pipe curl to shell
      /\bwget\b.*\|\s*(ba)?sh/,            // Pipe wget to shell
      />\s*\/etc\//,                        // Redirect to /etc/
      /\bnpm\s+publish\b/,                 // Publish to npm
      /\bgit\s+push\b.*--force/,           // Force push (duplicate but important)
      /\bsudo\b/,                           // Anything with sudo
      /\beval\b/,                           // eval commands
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(command.trim())) return PermissionLevel.DENY;
    }

    // Everything else: confirm
    return PermissionLevel.CONFIRM;
  }

  private isInsideProject(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    return resolved.startsWith(this.projectRoot);
  }

  private isProtectedPath(filePath: string): boolean {
    const protectedPrefixes = [
      "/etc", "/usr", "/bin", "/sbin", "/var",
      "/sys", "/proc", "/dev", "/boot",
    ];
    const resolved = path.resolve(filePath);
    return protectedPrefixes.some(p => resolved.startsWith(p));
  }
}
```

### User Confirmation Flow

When permission level is CONFIRM, the CLI prompts the user:

```
The agent wants to run: git commit -m "Add new feature"
[A]llow / [D]eny / [A]lways allow this / [N]ever allow this? >
```

Options:
- **Allow**: Proceed this once.
- **Deny**: Block this once.
- **Always allow**: Remember this tool+pattern as ALLOW for the session.
- **Never allow**: Remember as DENY for the session.

```typescript
interface ConfirmationResult {
  allowed: boolean;
  remember: boolean;
}

async function confirmWithUser(
  action: ToolAction,
  renderer: OutputRenderer,
): Promise<ConfirmationResult> {
  const description = describeAction(action);
  renderer.displayConfirmationPrompt(description);

  const answer = await readSingleKey(); // a, d, A, N

  switch (answer) {
    case "a": return { allowed: true, remember: false };
    case "d": return { allowed: false, remember: false };
    case "A": return { allowed: true, remember: true };
    case "N": return { allowed: false, remember: true };
    default: return { allowed: false, remember: false };
  }
}
```

### Session Persistence for Remembered Decisions

Remembered decisions are session-scoped by default (cleared on exit). They are stored in memory, not on disk, to prevent stale permission grants from persisting across sessions.

If the user wants persistent permission rules, they should use the config file:

```json
{
  "tools": {
    "bash": {
      "alwaysAllow": ["git *", "npm test", "pnpm *"],
      "alwaysDeny": ["rm -rf *"]
    }
  }
}
```

### Audit Log

Every tool execution is logged for transparency:

```typescript
interface AuditEntry {
  timestamp: Date;
  toolName: string;
  inputs: Record<string, unknown>;
  permission: PermissionLevel;
  userDecision?: "allowed" | "denied";
  result: "success" | "error" | "blocked";
  durationMs: number;
}

class AuditLog {
  private entries: AuditEntry[] = [];

  log(entry: AuditEntry): void {
    this.entries.push(entry);

    if (this.config.verbosity === "debug") {
      console.log(chalk.dim(
        `[AUDIT] ${entry.toolName} ${entry.result} (${entry.durationMs}ms)`
      ));
    }
  }

  /** Export audit log (for post-session review) */
  export(): AuditEntry[] {
    return [...this.entries];
  }
}
```

### Max Tool Turns Safety

Prevent infinite loops where the agent keeps calling tools without producing a response:

```typescript
const MAX_TOOL_TURNS = 25; // Configurable

// In the agent loop:
let consecutiveToolTurns = 0;

while (true) {
  const response = await provider.chat(messages, tools);

  if (response.toolCalls && response.toolCalls.length > 0) {
    consecutiveToolTurns++;

    if (consecutiveToolTurns >= MAX_TOOL_TURNS) {
      // Force the agent to respond with text
      messages.push({
        role: "system",
        content: "You have used too many consecutive tool calls. Please provide a text response summarizing your progress and what you've done so far.",
      });
      continue;
    }

    // Execute tools...
  } else {
    consecutiveToolTurns = 0; // Reset on text response
    break;
  }
}
```

## File Locations

- `src/safety/permissions.ts` — Permission manager
- `src/safety/audit.ts` — Audit log
- `src/safety/confirmation.ts` — User confirmation UI

## Acceptance Criteria

1. Read-only operations inside project are auto-allowed.
2. File operations outside project require confirmation.
3. File deletes always require confirmation.
4. Dangerous bash commands are blocked.
5. Safe bash commands are auto-allowed.
6. Unknown bash commands require confirmation.
7. User can allow/deny with "remember" option.
8. Audit log captures all tool executions.
9. Max tool turns prevents infinite loops.
10. "yolo" mode bypasses all confirmations.
11. "confirm-all" mode confirms everything.
12. Unit tests for all command classifications.

## Dependencies

- T-001, T-006

## Blocks

- T-017 (Agent Loop integrates permission checks)
- T-020 (CLI shows confirmation prompts)
