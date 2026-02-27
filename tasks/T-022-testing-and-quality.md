# T-022: Testing Framework and Quality Assurance

## Status: Pending

## Priority: High

## Summary

Set up the testing infrastructure and write comprehensive tests for all components. This includes unit tests for individual tools and modules, integration tests for the agent loop, and end-to-end tests that verify the full flow from user input to agent response.

## Context

An autonomous coding agent must be reliable — bugs in tools can corrupt user files, bugs in the agent loop can cause infinite loops, and bugs in the permission system can allow dangerous operations. Thorough testing is essential.

## Detailed Implementation

### Test Framework

**Vitest** (chosen in T-001):
- Fast, native TypeScript support
- Jest-compatible API
- Built-in mocking
- Parallel test execution

### Test Structure

```
tests/
├── unit/
│   ├── tools/
│   │   ├── file-read.test.ts
│   │   ├── file-write.test.ts
│   │   ├── file-edit.test.ts
│   │   ├── file-delete.test.ts
│   │   ├── glob.test.ts
│   │   ├── grep.test.ts
│   │   ├── bash.test.ts
│   │   └── http-request.test.ts
│   ├── agent/
│   │   ├── conversation.test.ts
│   │   ├── agent-loop.test.ts
│   │   └── system-prompt.test.ts
│   ├── providers/
│   │   ├── ollama.test.ts
│   │   └── provider-factory.test.ts
│   ├── config/
│   │   └── config-loader.test.ts
│   └── safety/
│       ├── permissions.test.ts
│       └── audit.test.ts
├── integration/
│   ├── agent-with-tools.test.ts
│   ├── ollama-live.test.ts         # Requires running Ollama
│   └── multi-turn-tool-use.test.ts
├── e2e/
│   └── full-flow.test.ts           # Simulates user session
├── fixtures/
│   ├── sample-project/             # Fake project for file tool tests
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── utils.ts
│   │   └── tests/
│   │       └── index.test.ts
│   └── mock-responses/             # Canned LLM responses for testing
│       ├── text-only.json
│       ├── single-tool-call.json
│       ├── multi-tool-call.json
│       └── streaming-chunks.json
├── helpers/
│   ├── temp-dir.ts                 # Create/cleanup temp directories
│   ├── mock-provider.ts            # Mock LLM provider
│   └── mock-http-server.ts         # Mock HTTP server for http_request tests
└── setup.ts                        # Global test setup
```

### Unit Test Examples

#### File Edit Tool

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileEditTool } from "@/tools/file-edit";
import { createTempDir, cleanupTempDir } from "../helpers/temp-dir";
import * as fs from "fs/promises";
import * as path from "path";

describe("FileEditTool", () => {
  let tmpDir: string;
  let tool: FileEditTool;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    tool = new FileEditTool();
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  it("replaces a unique string", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    await fs.writeFile(filePath, "const x = 1;\nconst y = 2;\nconst z = 3;\n");

    const result = await tool.execute({
      file_path: filePath,
      old_string: "const y = 2;",
      new_string: "const y = 42;",
    });

    expect(result.output).toContain("Replaced 1 occurrence");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("const x = 1;\nconst y = 42;\nconst z = 3;\n");
  });

  it("errors on ambiguous match", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    await fs.writeFile(filePath, "foo\nfoo\nfoo\n");

    const result = await tool.execute({
      file_path: filePath,
      old_string: "foo",
      new_string: "bar",
    });

    expect(result.output).toContain("appears 3 times");
  });

  it("errors when old_string not found", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    await fs.writeFile(filePath, "hello world\n");

    const result = await tool.execute({
      file_path: filePath,
      old_string: "goodbye",
      new_string: "hi",
    });

    expect(result.output).toContain("not found");
  });

  it("handles replace_all mode", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    await fs.writeFile(filePath, "foo bar foo baz foo\n");

    const result = await tool.execute({
      file_path: filePath,
      old_string: "foo",
      new_string: "qux",
      replace_all: true,
    });

    expect(result.output).toContain("Replaced 3 occurrences");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("qux bar qux baz qux\n");
  });

  it("rejects same old and new strings", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    await fs.writeFile(filePath, "hello\n");

    const result = await tool.execute({
      file_path: filePath,
      old_string: "hello",
      new_string: "hello",
    });

    expect(result.output).toContain("identical");
  });
});
```

#### Bash Tool

```typescript
describe("BashTool", () => {
  it("executes a simple command", async () => {
    const result = await tool.execute({ command: "echo hello" });
    expect(result.output).toContain("hello");
    expect(result.output).toContain("[Exit code: 0]");
  });

  it("captures stderr", async () => {
    const result = await tool.execute({ command: "echo error >&2" });
    expect(result.output).toContain("error");
  });

  it("reports non-zero exit code", async () => {
    const result = await tool.execute({ command: "exit 1" });
    expect(result.output).toContain("[Exit code: 1]");
  });

  it("times out long-running commands", async () => {
    const result = await tool.execute({
      command: "sleep 10",
      timeout: 1000,
    });
    expect(result.output).toContain("timed out");
  });

  it("truncates large output", async () => {
    const result = await tool.execute({
      command: "yes | head -100000",
    });
    expect(result.output).toContain("truncated");
  });
});
```

### Integration Test: Agent with Mock Provider

```typescript
describe("Agent Integration", () => {
  it("handles a multi-turn tool-use conversation", async () => {
    // Set up a mock provider that returns:
    // Turn 1: tool_call to file_read
    // Turn 2: text response
    const mockProvider = new MockProvider([
      {
        content: null,
        toolCalls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "file_read",
            arguments: JSON.stringify({ file_path: "/tmp/test.txt" }),
          },
        }],
      },
      {
        content: "The file contains: hello world",
        toolCalls: undefined,
      },
    ]);

    // Create temp file
    await fs.writeFile("/tmp/test.txt", "hello world");

    const agent = new Agent({ provider: mockProvider, tools: [new FileReadTool()] });
    const response = await agent.run("What's in /tmp/test.txt?");

    expect(response).toBe("The file contains: hello world");
    expect(mockProvider.callCount).toBe(2);
  });
});
```

### Mock Provider

```typescript
class MockProvider implements LLMProvider {
  private responses: ChatResponse[];
  private currentIndex = 0;
  callCount = 0;
  receivedMessages: Message[][] = [];

  constructor(responses: ChatResponse[]) {
    this.responses = responses;
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.callCount++;
    this.receivedMessages.push([...messages]);
    if (this.currentIndex >= this.responses.length) {
      throw new Error("MockProvider: no more responses configured");
    }
    return this.responses[this.currentIndex++];
  }

  async *chatStream(messages: Message[], tools?: ToolDefinition[]): AsyncIterable<StreamEvent> {
    const response = await this.chat(messages, tools);
    if (response.content) {
      yield { type: "token", content: response.content };
    }
    yield { type: "done", fullResponse: response };
  }
}
```

### Test Helpers

```typescript
// temp-dir.ts
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ollama-claude-test-"));
}

export async function cleanupTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
```

### CI Configuration

GitHub Actions workflow:

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm build
```

### Test Scripts in package.json

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "vitest run tests/e2e",
    "test:coverage": "vitest run --coverage"
  }
}
```

## File Locations

- `tests/` — All test files
- `vitest.config.ts` — Vitest configuration
- `.github/workflows/test.yml` — CI workflow

### Skipping Live Provider Tests

Integration tests that require a running Ollama instance are gated behind an environment variable:

```typescript
const OLLAMA_AVAILABLE = process.env.OLLAMA_TEST === "1";

describe.skipIf(!OLLAMA_AVAILABLE)("Ollama Live Tests", () => {
  it("sends a chat message and receives a response", async () => {
    // ...
  });
});
```

Run live tests explicitly: `OLLAMA_TEST=1 pnpm test:integration`

### E2E Test Example

A full end-to-end test simulates a user session:

```typescript
describe("E2E: File editing flow", () => {
  it("reads a file, edits it, and verifies the change", async () => {
    const tmpDir = await createTempDir();
    await fs.writeFile(path.join(tmpDir, "hello.ts"), "const msg = 'hello';\n");

    const mockProvider = new MockProvider([
      // Turn 1: LLM reads the file
      { content: null, toolCalls: [{ id: "1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ file_path: path.join(tmpDir, "hello.ts") }) } }] },
      // Turn 2: LLM edits the file
      { content: null, toolCalls: [{ id: "2", type: "function", function: { name: "file_edit", arguments: JSON.stringify({ file_path: path.join(tmpDir, "hello.ts"), old_string: "'hello'", new_string: "'world'" }) } }] },
      // Turn 3: LLM responds with text
      { content: "Done! I changed 'hello' to 'world'.", toolCalls: undefined },
    ]);

    const agent = new Agent({ provider: mockProvider, tools: getAllTools() });
    const response = await agent.run("Change hello to world in hello.ts");

    expect(response).toContain("world");
    const content = await fs.readFile(path.join(tmpDir, "hello.ts"), "utf-8");
    expect(content).toBe("const msg = 'world';\n");

    await cleanupTempDir(tmpDir);
  });
});
```

### Fixture Management

Mock LLM responses are stored as JSON fixtures in `tests/fixtures/mock-responses/`:
- Each fixture is a self-contained test scenario with an array of `ChatResponse` objects.
- Fixtures are versioned alongside the code.
- When the provider response format changes, update fixtures and run all tests to verify compatibility.

## Acceptance Criteria

1. Every tool has comprehensive unit tests.
2. Agent loop has integration tests with mock providers.
3. Permission system has unit tests for all command classifications.
4. Config loader has tests for all sources and merge order.
5. Conversation manager has tests for truncation and chain integrity.
6. All tests pass with `pnpm test`.
7. Code coverage is above 80%.
8. CI workflow runs on push and PR.
9. Test helpers are reusable and well-documented.

## Dependencies

- T-001 (project setup with vitest)
- All other tasks (each task's code needs tests)

## Blocks

- None — testing is done alongside or after implementation.
