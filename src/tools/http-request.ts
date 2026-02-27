import { z } from "zod";
import * as net from "node:net";
import * as dns from "node:dns/promises";
import { BaseTool, type ToolResult } from "./types.js";

const MAX_RESPONSE_SIZE = 1024 * 1024; // 1MB
const DEFAULT_TIMEOUT = 30_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "ollama-claude-agent/1.0";

/**
 * Private/internal IP ranges for SSRF protection.
 */
const PRIVATE_RANGES = [
  { prefix: "127.", mask: 8 },       // 127.0.0.0/8
  { prefix: "10.", mask: 8 },        // 10.0.0.0/8
  { prefix: "172.16.", mask: 12 },   // 172.16.0.0/12
  { prefix: "172.17.", mask: 12 },
  { prefix: "172.18.", mask: 12 },
  { prefix: "172.19.", mask: 12 },
  { prefix: "172.20.", mask: 12 },
  { prefix: "172.21.", mask: 12 },
  { prefix: "172.22.", mask: 12 },
  { prefix: "172.23.", mask: 12 },
  { prefix: "172.24.", mask: 12 },
  { prefix: "172.25.", mask: 12 },
  { prefix: "172.26.", mask: 12 },
  { prefix: "172.27.", mask: 12 },
  { prefix: "172.28.", mask: 12 },
  { prefix: "172.29.", mask: 12 },
  { prefix: "172.30.", mask: 12 },
  { prefix: "172.31.", mask: 12 },
  { prefix: "192.168.", mask: 16 },  // 192.168.0.0/16
  { prefix: "169.254.", mask: 16 },  // 169.254.0.0/16 (link-local)
  { prefix: "0.", mask: 8 },         // 0.0.0.0/8
];

/**
 * Allowed localhost endpoints (e.g., Ollama API).
 */
const ALLOWED_LOCAL = [
  { host: "localhost", port: 11434 },  // Ollama
  { host: "127.0.0.1", port: 11434 },
];

function isPrivateIP(ip: string): boolean {
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true; // IPv6 loopback
  for (const range of PRIVATE_RANGES) {
    if (ip.startsWith(range.prefix)) return true;
  }
  return false;
}

function isAllowedLocal(hostname: string, port: number): boolean {
  return ALLOWED_LOCAL.some((a) => a.host === hostname && a.port === port);
}

const inputSchema = z.object({
  url: z.string().describe("URL to request (http or https only)"),
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    .optional()
    .describe("HTTP method (default: GET)"),
  headers: z
    .record(z.string())
    .optional()
    .describe("Request headers as key-value pairs"),
  body: z.string().optional().describe("Request body (for POST/PUT/PATCH)"),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .optional()
    .describe("Timeout in milliseconds (default: 30000)"),
});

type HttpRequestInput = z.infer<typeof inputSchema>;

export class HttpRequestTool extends BaseTool<HttpRequestInput> {
  readonly name = "http_request";
  readonly description =
    "Make an HTTP request and return the response. Only http:// and https:// URLs are allowed. Requests to private/internal networks are blocked by default (SSRF protection).";
  readonly inputSchema = inputSchema;

  async execute(input: HttpRequestInput): Promise<ToolResult> {
    // Validate URL
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { output: `Error: Invalid URL: ${input.url}` };
    }

    // Scheme check
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { output: `Error: Only http:// and https:// URLs are allowed, got: ${url.protocol}` };
    }

    // Strip embedded credentials
    if (url.username || url.password) {
      return {
        output: `Error: URL contains embedded credentials (user:pass@host). Use the headers parameter with Authorization instead.`,
      };
    }

    // SSRF protection: resolve hostname and check for private IPs
    const hostname = url.hostname;
    const port = url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80);

    if (!isAllowedLocal(hostname, port)) {
      // Check if hostname is an IP literal
      if (net.isIP(hostname)) {
        if (isPrivateIP(hostname)) {
          return { output: `Error: Requests to private/internal IP addresses are blocked: ${hostname}` };
        }
      } else {
        // Resolve DNS and check
        try {
          const addresses = await dns.resolve4(hostname);
          for (const addr of addresses) {
            if (isPrivateIP(addr)) {
              return { output: `Error: Hostname "${hostname}" resolves to private IP ${addr} — blocked for SSRF protection` };
            }
          }
        } catch {
          // DNS resolution failed — let fetch handle it
        }
      }
    }

    // Build request
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      ...(input.headers || {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeout ?? DEFAULT_TIMEOUT);
    const startTime = Date.now();

    try {
      const response = await fetch(input.url, {
        method: input.method ?? "GET",
        headers,
        body: input.body && ["POST", "PUT", "PATCH"].includes(input.method ?? "GET") ? input.body : undefined,
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timer);
      const elapsed = Date.now() - startTime;

      // Read response body with size limit
      const contentType = response.headers.get("content-type") || "";
      let body: string;

      if (input.method === "HEAD") {
        body = "(HEAD request — no body)";
      } else {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_RESPONSE_SIZE) {
          body = `(Response too large: ${buffer.byteLength} bytes, max ${MAX_RESPONSE_SIZE} bytes)`;
        } else if (contentType.includes("application/json")) {
          // Pretty-print JSON
          try {
            const raw = new TextDecoder().decode(buffer);
            body = JSON.stringify(JSON.parse(raw), null, 2);
          } catch {
            body = new TextDecoder().decode(buffer);
          }
        } else if (
          contentType.includes("text/") ||
          contentType.includes("application/xml") ||
          contentType.includes("application/javascript")
        ) {
          body = new TextDecoder().decode(buffer);
        } else if (buffer.byteLength === 0) {
          body = "(empty response body)";
        } else {
          body = `(Binary response: ${contentType || "unknown type"}, ${buffer.byteLength} bytes)`;
        }
      }

      // Truncate very long text bodies
      if (body.length > MAX_RESPONSE_SIZE) {
        body = body.slice(0, MAX_RESPONSE_SIZE) + "\n... (truncated)";
      }

      // Format response headers
      const respHeaders: string[] = [];
      response.headers.forEach((value, key) => {
        respHeaders.push(`  ${key}: ${value}`);
      });

      const output = [
        `${response.status} ${response.statusText}`,
        `Elapsed: ${elapsed}ms`,
        "",
        "Response Headers:",
        respHeaders.join("\n"),
        "",
        "Body:",
        body,
      ].join("\n");

      return {
        output,
        metadata: {
          status: response.status,
          statusText: response.statusText,
          elapsed,
          contentType,
        },
      };
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort")) {
        return { output: `Error: Request timed out after ${input.timeout ?? DEFAULT_TIMEOUT}ms` };
      }
      return { output: `Error: Request failed: ${msg}` };
    }
  }
}
