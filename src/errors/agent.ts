import { AgentError } from "./base.js";

export class AgentLoopError extends AgentError {
  constructor(message: string, code: string) {
    super({ message, code, retryable: false });
    this.name = "AgentLoopError";
  }
}

export class MaxTurnsExceededError extends AgentLoopError {
  constructor(maxTurns: number) {
    super(`Agent exceeded maximum of ${maxTurns} turns`, "AGENT_MAX_TURNS");
    this.name = "MaxTurnsExceededError";
  }
}
