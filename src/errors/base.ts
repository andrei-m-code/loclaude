export interface AgentErrorOptions {
  message: string;
  code: string;
  retryable?: boolean;
  cause?: Error;
  context?: Record<string, unknown>;
}

export class AgentError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;

  constructor(options: AgentErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "AgentError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.context = options.context ?? {};
  }
}
