import { AgentError, type AgentErrorOptions } from "./base.js";

export class ProviderError extends AgentError {
  constructor(options: AgentErrorOptions) {
    super(options);
    this.name = "ProviderError";
  }
}

export class ProviderConnectionError extends ProviderError {
  constructor(message: string, cause?: Error) {
    super({
      message,
      code: "PROVIDER_CONNECTION_FAILED",
      retryable: true,
      cause,
    });
    this.name = "ProviderConnectionError";
  }
}

export class ProviderModelNotFoundError extends ProviderError {
  constructor(model: string) {
    super({
      message: `Model '${model}' not found. Run \`ollama pull ${model}\` to download it.`,
      code: "PROVIDER_MODEL_NOT_FOUND",
      retryable: false,
      context: { model },
    });
    this.name = "ProviderModelNotFoundError";
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(timeoutMs: number, cause?: Error) {
    super({
      message: `Provider request timed out after ${timeoutMs}ms`,
      code: "PROVIDER_TIMEOUT",
      retryable: true,
      cause,
      context: { timeoutMs },
    });
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderResponseError extends ProviderError {
  constructor(message: string, cause?: Error) {
    super({
      message,
      code: "PROVIDER_INVALID_RESPONSE",
      retryable: false,
      cause,
    });
    this.name = "ProviderResponseError";
  }
}
