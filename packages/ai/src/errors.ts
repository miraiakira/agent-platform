export type AIErrorCode =
  | "AUTH_ERROR"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "CANCELLED"
  | "PROVIDER_ERROR"
  | "INVALID_RESPONSE"
  | "CONFIG_ERROR";

export class AIError extends Error {
  constructor(
    public readonly code: AIErrorCode,
    message: string,
    public readonly statusCode = 500,
  ) {
    super(message);
    this.name = "AIError";
  }
}