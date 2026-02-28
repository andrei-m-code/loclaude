import * as fs from "node:fs";
import * as path from "node:path";

export interface SessionConfig {
  provider?: string;
  model?: string;
  apiKeys?: Record<string, string>; // { openai: "sk-..." }
  baseUrl?: string;
  maxRetries?: number; // retry count for rate-limited/failed requests (default: 3)
}

const SESSION_FILE = "LOCLAUDE.md";

export function getSessionPath(cwd: string): string {
  return path.join(cwd, SESSION_FILE);
}

export function loadSession(cwd: string): SessionConfig | null {
  const filePath = getSessionPath(cwd);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return parseSession(content);
  } catch {
    return null;
  }
}

export function saveSession(cwd: string, session: SessionConfig): void {
  const filePath = getSessionPath(cwd);
  const content = serializeSession(session);
  fs.writeFileSync(filePath, content, "utf-8");
}

function parseSession(content: string): SessionConfig {
  const config: SessionConfig = {};
  const apiKeys: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (!value) continue;

    if (key === "provider") {
      config.provider = value;
    } else if (key === "model") {
      config.model = value;
    } else if (key === "baseUrl") {
      config.baseUrl = value;
    } else if (key === "maxRetries") {
      const n = parseInt(value, 10);
      if (!isNaN(n) && n >= 0) config.maxRetries = n;
    } else if (key.startsWith("apikey.")) {
      const providerName = key.slice("apikey.".length);
      apiKeys[providerName] = value;
    }
  }

  if (Object.keys(apiKeys).length > 0) {
    config.apiKeys = apiKeys;
  }

  return config;
}

function serializeSession(session: SessionConfig): string {
  const lines: string[] = ["# loclaude session"];

  if (session.provider) {
    lines.push(`provider: ${session.provider}`);
  }
  if (session.model) {
    lines.push(`model: ${session.model}`);
  }
  if (session.baseUrl) {
    lines.push(`baseUrl: ${session.baseUrl}`);
  }
  if (session.maxRetries !== undefined) {
    lines.push(`maxRetries: ${session.maxRetries}`);
  }
  if (session.apiKeys) {
    for (const [name, key] of Object.entries(session.apiKeys)) {
      lines.push(`apikey.${name}: ${key}`);
    }
  }

  return lines.join("\n") + "\n";
}
