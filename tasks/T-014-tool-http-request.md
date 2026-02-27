# T-014: HTTP Request Tool

## Status: Pending

## Priority: Medium

## Summary

Implement the `http_request` tool that allows the agent to make HTTP requests to external APIs and web services. This enables the agent to fetch documentation, interact with APIs, download content, check service health, and more.

## Context

Use cases for HTTP requests:
- Fetching API documentation or changelogs.
- Testing API endpoints during development.
- Downloading files or content.
- Interacting with web services (GitHub API, npm registry, etc.).
- Checking if a service is running (health checks).

## Detailed Implementation

### Tool Specification

| Property | Value |
|----------|-------|
| Name | `http_request` |
| Description | "Make an HTTP request to a URL and return the response. Supports GET, POST, PUT, PATCH, DELETE methods. Returns response status, headers, and body." |

### Input Schema

```typescript
const inputSchema = z.object({
  url: z.string().url()
    .describe("The URL to send the request to (must be a valid URL)"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional().default("GET")
    .describe("HTTP method. Default: GET"),
  headers: z.record(z.string()).optional()
    .describe("Request headers as key-value pairs (e.g., {'Authorization': 'Bearer token', 'Content-Type': 'application/json'})"),
  body: z.string().optional()
    .describe("Request body (for POST, PUT, PATCH). Typically JSON string."),
  timeout: z.number().int().min(1000).max(60000).optional().default(30000)
    .describe("Request timeout in milliseconds. Default: 30000 (30 seconds)."),
});
```

### Behavior

1. **Validate URL** — must be a valid URL. Only allow `http://` and `https://` schemes.
2. **Set up request** — using Node.js built-in `fetch` API (available since Node 18).
3. **Send request** — with the specified method, headers, body, and timeout.
4. **Process response**:
   - Read status code and status text.
   - Read response headers.
   - Read response body.
   - Auto-detect content type and format appropriately.
5. **Format output** — human-readable summary.

### Output Format

```
HTTP GET https://api.github.com/repos/anthropics/claude-code

Status: 200 OK

Response Headers:
  content-type: application/json; charset=utf-8
  x-ratelimit-remaining: 59

Response Body:
{
  "id": 123456,
  "name": "claude-code",
  "full_name": "anthropics/claude-code",
  "description": "CLI for Claude",
  ...
}

[Response: 200 OK, 2.3KB, 145ms]
```

For HTML responses (truncated and simplified):
```
HTTP GET https://example.com

Status: 200 OK

Response Body (text/html, truncated):
<!DOCTYPE html>
<html>
<head><title>Example Domain</title></head>
<body>
<h1>Example Domain</h1>
<p>This domain is for use in illustrative examples...</p>
</body>
</html>

[Response: 200 OK, 1.2KB, 89ms]
```

### Content Handling

| Content-Type | Handling |
|-------------|----------|
| `application/json` | Pretty-print with 2-space indent |
| `text/html` | Return as-is (up to size limit) |
| `text/plain` | Return as-is |
| `text/xml`, `application/xml` | Return as-is |
| Binary types | Return `"(Binary response: {content-type}, {size} bytes)"` |

### Safety Considerations

- **URL validation**: Only `http://` and `https://` schemes. No `file://`, `ftp://`, etc.
- **SSRF protection**: Block requests to internal networks by default:
  - `127.0.0.0/8` (localhost)
  - `10.0.0.0/8` (private)
  - `172.16.0.0/12` (private)
  - `192.168.0.0/16` (private)
  - `169.254.0.0/16` (link-local)
  - Exception: `localhost:11434` (Ollama) and other explicitly allowed local services.
  - This can be disabled via configuration for development.
- **Response size limit**: Max 1MB response body. Truncate larger responses.
- **No automatic redirects beyond limit**: Follow up to 5 redirects, then stop.
- **Timeout**: Default 30 seconds, configurable.

### Implementation

```typescript
class HttpRequestTool extends BaseTool<HttpRequestInput> {
  readonly name = "http_request";
  readonly description = "Make an HTTP request to a URL and return the response.";

  readonly inputSchema = z.object({
    url: z.string().url().describe("The URL to request"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional().default("GET"),
    headers: z.record(z.string()).optional().describe("Request headers"),
    body: z.string().optional().describe("Request body"),
    timeout: z.number().int().min(1000).max(60000).optional().default(30000),
  });

  private maxResponseSize = 1024 * 1024; // 1MB

  async execute(input: HttpRequestInput): Promise<ToolResult> {
    const { url, method, headers, body, timeout } = input;

    // Validate URL scheme
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { output: `Error: Only HTTP and HTTPS URLs are supported. Got: ${parsed.protocol}` };
    }

    // SSRF check (skip for allowed local services)
    if (this.isBlockedAddress(parsed.hostname)) {
      return { output: `Error: Requests to internal/private network addresses are blocked for security.` };
    }

    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method,
        headers: {
          "User-Agent": "ollama-claude-agent/1.0",
          ...headers,
        },
        body: method !== "GET" && method !== "HEAD" ? body : undefined,
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timer);

      const elapsed = Date.now() - startTime;

      // Read response body
      const contentType = response.headers.get("content-type") ?? "unknown";
      let responseBody: string;

      if (this.isBinaryContentType(contentType)) {
        const buffer = await response.arrayBuffer();
        responseBody = `(Binary response: ${contentType}, ${buffer.byteLength} bytes)`;
      } else {
        const text = await response.text();
        if (text.length > this.maxResponseSize) {
          responseBody = text.slice(0, this.maxResponseSize) + `\n\n... (response truncated at 1MB)`;
        } else {
          responseBody = this.formatResponseBody(text, contentType);
        }
      }

      // Format selected response headers
      const relevantHeaders = this.getRelevantHeaders(response.headers);
      const headersStr = relevantHeaders.map(([k, v]) => `  ${k}: ${v}`).join("\n");

      const sizeStr = this.formatSize(responseBody.length);

      let output = `HTTP ${method} ${url}\n\n`;
      output += `Status: ${response.status} ${response.statusText}\n\n`;
      if (headersStr) output += `Response Headers:\n${headersStr}\n\n`;
      output += `Response Body:\n${responseBody}\n\n`;
      output += `[Response: ${response.status} ${response.statusText}, ${sizeStr}, ${elapsed}ms]`;

      return { output };
    } catch (err) {
      if (err.name === "AbortError") {
        return { output: `Error: Request timed out after ${timeout / 1000} seconds` };
      }
      return { output: `Error: ${err.message}` };
    }
  }
}
```

## File Location

- `src/tools/http-request.ts`

### Authentication Patterns

Common authentication methods work through the existing `headers` parameter:

- **Bearer token**: `{"Authorization": "Bearer <token>"}`
- **Basic auth**: `{"Authorization": "Basic <base64(user:pass)>"}`
- **API key header**: `{"X-API-Key": "<key>"}`
- **Custom headers**: Any header can be set via the `headers` object.

URL-embedded credentials (e.g., `https://user:pass@host/`) are NOT supported — they are stripped and a warning is returned.

### TLS Certificate Handling

- HTTPS certificates are always validated by default (Node.js default behavior).
- For development environments with self-signed certificates, the user can set `NODE_TLS_REJECT_UNAUTHORIZED=0` as an environment variable (not recommended for production).
- The agent does NOT provide a built-in option to skip TLS verification to avoid creating security footguns.

## Acceptance Criteria

1. GET requests work and return formatted output.
2. POST/PUT/PATCH with body work.
3. Custom headers are sent correctly.
4. JSON responses are pretty-printed.
5. Binary responses are identified (not dumped as text).
6. Timeout mechanism works.
7. Response size limit works.
8. SSRF protection blocks internal addresses.
9. URL validation rejects invalid/non-HTTP URLs.
10. Unit tests with a mock HTTP server (use `http.createServer` or MSW).

## Dependencies

- T-001, T-006

## Blocks

- None directly.
