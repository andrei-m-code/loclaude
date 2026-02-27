// -- Types --

export interface PlanStep {
  stepNumber: number;
  description: string;
  tool: string;
  expectedOutcome: string;
}

export interface ExecutionPlan {
  summary: string;
  steps: PlanStep[];
  isSimpleQuestion: boolean;
}

export interface StepResult {
  stepNumber: number;
  text: string;
  toolCall?: { toolName: string; toolCallId: string; args: Record<string, unknown> };
  toolResult?: { output: string; isError: boolean };
  success: boolean;
}

export interface VerificationResult {
  status: "complete" | "partial" | "failed";
  summary: string;
  issues: string[];
}

// -- Prompt Builders --

export function buildPlanningPrompt(
  userMessage: string,
  toolNames: string[],
  workingDirectory: string,
): string {
  const toolList = toolNames.length > 0 ? toolNames.join(", ") : "none";

  return `You are a planning assistant. Your job is to analyze the user's request and create a step-by-step execution plan. Do NOT execute anything — only plan.

## Available Tools
${toolList}

## Working Directory
${workingDirectory}

## Rules
- Output a JSON array inside <plan> tags.
- Each step has: stepNumber (1-based), description, tool (tool name or "none"), expectedOutcome.
- Maximum 10 steps.
- Each step uses exactly 0 or 1 tool.
- For simple questions that need no tools, output a single step with tool "none".
- Be specific: include file paths, command strings, patterns in the description.

## Examples

### Example 1 — Simple question
User: "What is a closure in JavaScript?"

<plan>
{"summary": "Answer a conceptual question about JavaScript closures", "steps": [{"stepNumber": 1, "description": "Explain what a closure is in JavaScript", "tool": "none", "expectedOutcome": "Clear explanation of closures"}]}
</plan>

### Example 2 — Multi-step coding task
User: "Read package.json and tell me what dependencies we have"

<plan>
{"summary": "Read package.json and summarize dependencies", "steps": [{"stepNumber": 1, "description": "Read the package.json file", "tool": "file_read", "expectedOutcome": "Contents of package.json"}, {"stepNumber": 2, "description": "Summarize the dependencies found in package.json", "tool": "none", "expectedOutcome": "A list of dependencies with brief descriptions"}]}
</plan>

## User Request
${userMessage}

<plan>
`;
}

export function buildStepExecutionPrompt(
  userMessage: string,
  plan: ExecutionPlan,
  currentStep: PlanStep,
  completedSteps: StepResult[],
  workingDirectory: string,
): string {
  let prompt = `You are executing step ${currentStep.stepNumber} of a plan to fulfill the user's request.

## Original Request
${userMessage}

## Full Plan
${plan.summary}
${plan.steps.map((s) => `${s.stepNumber}. ${s.description} (tool: ${s.tool})`).join("\n")}

## Working Directory
${workingDirectory}
`;

  if (completedSteps.length > 0) {
    prompt += "\n## Completed Steps\n";
    for (const step of completedSteps) {
      const status = step.success ? "OK" : "FAILED";
      let output = step.text;
      if (step.toolResult) {
        output = step.toolResult.output;
      }
      if (output.length > 1000) {
        output = output.slice(0, 1000) + "... (truncated)";
      }
      prompt += `Step ${step.stepNumber} [${status}]: ${output}\n`;
    }
  }

  prompt += `
## Current Step
Step ${currentStep.stepNumber}: ${currentStep.description}
Expected tool: ${currentStep.tool}
Expected outcome: ${currentStep.expectedOutcome}

## Instructions
Execute ONLY this step. ${currentStep.tool !== "none" ? `Use the "${currentStep.tool}" tool to accomplish it.` : "Respond with text only — do not use any tools."} Do not proceed to the next step.`;

  return prompt;
}

export function buildVerificationPrompt(
  userMessage: string,
  plan: ExecutionPlan,
  stepResults: StepResult[],
): string {
  let prompt = `You are verifying the results of an executed plan.

## Original Request
${userMessage}

## Plan Summary
${plan.summary}

## Step Results
`;

  for (const step of stepResults) {
    const status = step.success ? "OK" : "FAILED";
    let output = step.text;
    if (step.toolResult) {
      output = step.toolResult.output;
    }
    if (output.length > 500) {
      output = output.slice(0, 500) + "... (truncated)";
    }
    prompt += `Step ${step.stepNumber} [${status}]: ${output}\n`;
  }

  prompt += `
## Instructions
Evaluate whether the original request was fulfilled. Output your assessment inside <verify> tags as JSON:
{"status": "complete"|"partial"|"failed", "summary": "brief summary of what was accomplished", "issues": ["any issues or incomplete items"]}

<verify>
`;

  return prompt;
}

// -- Parsers --

/**
 * Attempt to clean and parse a JSON string, handling common model mistakes.
 */
function tryParseJson(raw: string): unknown | null {
  let text = raw.trim();

  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");

  // Fix trailing commas before } or ]
  text = text.replace(/,\s*([}\]])/g, "$1");

  // Fix single quotes → double quotes (only outside already-double-quoted strings)
  // Simple heuristic: replace ' with " if not inside a double-quoted string
  if (!text.includes('"') && text.includes("'")) {
    text = text.replace(/'/g, '"');
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Fuzzy-match a tool name against the registered tool names.
 */
function fuzzyMatchTool(name: string, toolNames: string[]): string {
  if (!name || name === "none") return "none";
  const lower = name.toLowerCase().trim();
  if (lower === "none") return "none";

  // Exact match
  if (toolNames.includes(lower)) return lower;

  // Partial match
  for (const tn of toolNames) {
    if (tn.includes(lower) || lower.includes(tn)) return tn;
  }

  return name;
}

/**
 * Validate and normalize a raw parsed plan object into an ExecutionPlan.
 */
function normalizePlan(raw: unknown, toolNames: string[]): ExecutionPlan | null {
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;
  let steps: unknown[];

  if (Array.isArray(obj)) {
    // Raw array of steps
    steps = obj;
  } else if (Array.isArray(obj.steps)) {
    steps = obj.steps;
  } else {
    return null;
  }

  if (steps.length === 0) return null;
  if (steps.length > 10) steps = steps.slice(0, 10);

  const normalizedSteps: PlanStep[] = steps.map((s, i) => {
    const step = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    return {
      stepNumber: typeof step.stepNumber === "number" ? step.stepNumber : i + 1,
      description: String(step.description ?? step.desc ?? `Step ${i + 1}`),
      tool: fuzzyMatchTool(String(step.tool ?? "none"), toolNames),
      expectedOutcome: String(step.expectedOutcome ?? step.expected_outcome ?? step.outcome ?? ""),
    };
  });

  const summary = typeof obj.summary === "string" ? obj.summary : normalizedSteps[0].description;
  const isSimpleQuestion =
    normalizedSteps.length === 1 && normalizedSteps[0].tool === "none";

  return { summary, steps: normalizedSteps, isSimpleQuestion };
}

/**
 * Parse plan from model output using multiple fallback strategies.
 */
export function parsePlan(rawOutput: string, toolNames: string[]): ExecutionPlan {
  // Strategy 1: Extract from <plan>...</plan> tags
  const planTagMatch = rawOutput.match(/<plan>\s*([\s\S]*?)\s*<\/plan>/i);
  if (planTagMatch) {
    const parsed = tryParseJson(planTagMatch[1]);
    if (parsed) {
      const plan = normalizePlan(parsed, toolNames);
      if (plan) return plan;
    }
  }

  // Strategy 2: Try entire text as raw JSON
  const fullParsed = tryParseJson(rawOutput);
  if (fullParsed) {
    const plan = normalizePlan(fullParsed, toolNames);
    if (plan) return plan;
  }

  // Strategy 3: Find JSON object containing "steps" anywhere in text
  const jsonObjectMatch = rawOutput.match(/\{[\s\S]*"steps"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
  if (jsonObjectMatch) {
    const parsed = tryParseJson(jsonObjectMatch[0]);
    if (parsed) {
      const plan = normalizePlan(parsed, toolNames);
      if (plan) return plan;
    }
  }

  // Strategy 3b: Find bare JSON array
  const jsonArrayMatch = rawOutput.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (jsonArrayMatch) {
    const parsed = tryParseJson(jsonArrayMatch[0]);
    if (parsed && Array.isArray(parsed)) {
      const plan = normalizePlan({ steps: parsed, summary: "" }, toolNames);
      if (plan) return plan;
    }
  }

  // Strategy 4: Heuristic numbered list parsing
  const numberedLines = rawOutput.match(/^\s*\d+\.\s+.+/gm);
  if (numberedLines && numberedLines.length > 0) {
    const steps: PlanStep[] = numberedLines.slice(0, 10).map((line, i) => {
      const desc = line.replace(/^\s*\d+\.\s+/, "").trim();
      // Try to detect tool name in parentheses, e.g. "Read file (file_read)"
      const toolMatch = desc.match(/\((\w+)\)\s*$/);
      const tool = toolMatch ? fuzzyMatchTool(toolMatch[1], toolNames) : "none";
      const cleanDesc = toolMatch ? desc.replace(/\s*\(\w+\)\s*$/, "") : desc;
      return {
        stepNumber: i + 1,
        description: cleanDesc,
        tool,
        expectedOutcome: "",
      };
    });

    const isSimple = steps.length === 1 && steps[0].tool === "none";
    return {
      summary: steps[0].description,
      steps,
      isSimpleQuestion: isSimple,
    };
  }

  // Fallback: treat as simple question
  return {
    summary: "Respond to user request",
    steps: [{ stepNumber: 1, description: "Respond to the user", tool: "none", expectedOutcome: "Direct response" }],
    isSimpleQuestion: true,
  };
}

/**
 * Parse verification result from model output.
 */
export function parseVerification(rawOutput: string): VerificationResult {
  // Strategy 1: Extract from <verify>...</verify> tags
  const verifyTagMatch = rawOutput.match(/<verify>\s*([\s\S]*?)\s*<\/verify>/i);
  if (verifyTagMatch) {
    const parsed = tryParseJson(verifyTagMatch[1]) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object") {
      return normalizeVerification(parsed);
    }
  }

  // Strategy 2: Try entire text as JSON
  const fullParsed = tryParseJson(rawOutput) as Record<string, unknown> | null;
  if (fullParsed && typeof fullParsed === "object") {
    return normalizeVerification(fullParsed);
  }

  // Strategy 3: Find JSON with "status" key
  const jsonMatch = rawOutput.match(/\{[\s\S]*"status"\s*:[\s\S]*\}/);
  if (jsonMatch) {
    const parsed = tryParseJson(jsonMatch[0]) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object") {
      return normalizeVerification(parsed);
    }
  }

  // Fallback: treat raw text as summary with status "complete"
  return {
    status: "complete",
    summary: rawOutput.trim().slice(0, 500) || "Verification complete",
    issues: [],
  };
}

function normalizeVerification(raw: Record<string, unknown>): VerificationResult {
  const status = String(raw.status ?? "complete");
  const validStatuses = ["complete", "partial", "failed"];
  return {
    status: (validStatuses.includes(status) ? status : "complete") as VerificationResult["status"],
    summary: String(raw.summary ?? ""),
    issues: Array.isArray(raw.issues) ? raw.issues.map(String) : [],
  };
}
