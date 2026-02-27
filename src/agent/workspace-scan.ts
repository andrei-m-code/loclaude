import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Quick workspace scan that runs once at startup.
 * Gives the agent awareness of what it's working with: project type,
 * directory structure, key config files, and git state.
 */

const IGNORE = new Set([
  "node_modules", ".git", "dist", "build", "coverage",
  ".next", "__pycache__", ".venv", "venv", ".tox",
  ".cache", ".parcel-cache", ".turbo", ".output",
  "target", "vendor", ".idea", ".vscode",
  ".DS_Store", "Thumbs.db",
]);

const CONFIG_FILES = [
  "package.json",
  "tsconfig.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "Makefile",
  "docker-compose.yml",
  "Dockerfile",
  ".env.example",
  "README.md",
];

/** Max lines to include from a config file snippet. */
const MAX_CONFIG_LINES = 30;
/** Max depth for directory tree. */
const MAX_DEPTH = 3;
/** Max entries per directory level. */
const MAX_ENTRIES = 25;

interface ScanResult {
  tree: string;
  configs: Array<{ name: string; snippet: string }>;
  gitBranch: string | null;
  gitDirty: boolean;
  summary: string;
}

/**
 * Build a compact directory tree string.
 */
async function buildTree(dir: string, prefix: string, depth: number): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  // Filter ignored and hidden (except key dotfiles)
  entries = entries.filter((e) => {
    if (IGNORE.has(e)) return false;
    if (e.startsWith(".") && !e.startsWith(".env") && e !== ".github") return false;
    return true;
  });

  entries.sort();
  const limited = entries.slice(0, MAX_ENTRIES);
  const truncated = entries.length > MAX_ENTRIES;
  const lines: string[] = [];

  for (let i = 0; i < limited.length; i++) {
    const entry = limited[i];
    const fullPath = path.join(dir, entry);
    const isLast = i === limited.length - 1 && !truncated;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";

    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      lines.push(prefix + connector + entry + "/");
      const children = await buildTree(fullPath, prefix + childPrefix, depth + 1);
      lines.push(...children);
    } else {
      lines.push(prefix + connector + entry);
    }
  }

  if (truncated) {
    lines.push(prefix + `└── ... (${entries.length - MAX_ENTRIES} more)`);
  }

  return lines;
}

/**
 * Detect the git branch and dirty state.
 */
async function getGitInfo(dir: string): Promise<{ branch: string | null; dirty: boolean }> {
  try {
    const headPath = path.join(dir, ".git", "HEAD");
    const head = await fs.readFile(headPath, "utf-8");
    const match = head.trim().match(/^ref: refs\/heads\/(.+)$/);
    const branch = match ? match[1] : head.trim().slice(0, 8);

    // Quick dirty check: look for uncommitted changes via .git/index mtime vs HEAD
    // (Rough heuristic — not as accurate as `git status` but zero-cost)
    let dirty = false;
    try {
      const indexPath = path.join(dir, ".git", "index");
      const indexStat = await fs.stat(indexPath);
      const headStat = await fs.stat(headPath);
      // If index is newer than HEAD by more than 2s, likely has staged changes
      dirty = indexStat.mtimeMs - headStat.mtimeMs > 2000;
    } catch {
      // No index = fresh repo
    }

    return { branch, dirty };
  } catch {
    return { branch: null, dirty: false };
  }
}

/**
 * Read a config file and return a compact snippet.
 */
async function readConfigSnippet(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    if (lines.length <= MAX_CONFIG_LINES) {
      return content.trim();
    }
    return lines.slice(0, MAX_CONFIG_LINES).join("\n") + `\n... (${lines.length - MAX_CONFIG_LINES} more lines)`;
  } catch {
    return null;
  }
}

/**
 * Detect the project type from config files present.
 */
function detectProjectType(configs: string[]): string {
  const has = (name: string) => configs.includes(name);

  const types: string[] = [];
  if (has("package.json")) {
    if (has("tsconfig.json")) types.push("TypeScript/Node.js");
    else types.push("JavaScript/Node.js");
  }
  if (has("Cargo.toml")) types.push("Rust");
  if (has("go.mod")) types.push("Go");
  if (has("pyproject.toml") || has("requirements.txt")) types.push("Python");
  if (has("Gemfile")) types.push("Ruby");
  if (has("Dockerfile") || has("docker-compose.yml")) types.push("Docker");

  return types.length > 0 ? types.join(" + ") : "Unknown";
}

/**
 * Scan the workspace and return a compact summary for the system prompt.
 */
export async function scanWorkspace(workingDirectory: string): Promise<string> {
  const results: string[] = [];

  // 1. Directory tree
  const treeLines = await buildTree(workingDirectory, "", 0);
  if (treeLines.length > 0) {
    results.push("### Directory Structure\n```\n" + path.basename(workingDirectory) + "/\n" + treeLines.join("\n") + "\n```");
  }

  // 2. Config files
  const foundConfigs: string[] = [];
  const configSnippets: Array<{ name: string; snippet: string }> = [];

  for (const name of CONFIG_FILES) {
    const filePath = path.join(workingDirectory, name);
    const snippet = await readConfigSnippet(filePath);
    if (snippet !== null) {
      foundConfigs.push(name);
      // Only include full snippet for the most important config files
      if (name === "package.json" || name === "Cargo.toml" || name === "go.mod" || name === "pyproject.toml") {
        configSnippets.push({ name, snippet });
      }
    }
  }

  // 3. Git info
  const git = await getGitInfo(workingDirectory);

  // 4. Project summary
  const projectType = detectProjectType(foundConfigs);
  let summary = `Project type: ${projectType}`;
  if (foundConfigs.length > 0) {
    summary += `\nConfig files: ${foundConfigs.join(", ")}`;
  }
  if (git.branch) {
    summary += `\nGit branch: ${git.branch}${git.dirty ? " (uncommitted changes)" : ""}`;
  }
  results.unshift("### Project Summary\n" + summary);

  // 5. Key config file contents
  for (const { name, snippet } of configSnippets) {
    results.push(`### ${name}\n\`\`\`json\n${snippet}\n\`\`\``);
  }

  return results.join("\n\n");
}
