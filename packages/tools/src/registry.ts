import { z } from "zod";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  signal?: AbortSignal;
  approval?: { id: string; jobId: string; leaseToken: string; callId: string; checkpointVersion: number; hash: string };
  authorization?: { tenantId: string; actorUserId: string; policyVersion: number };
}

export interface Tool<T extends z.ZodTypeAny> {
  name: string;
  description: string;
  /** Explicit safety declaration; unspecified tools must never be retried automatically. */
  retrySafe?: boolean;
  schema: T;
  parameters: Record<string, unknown>;
  execute(
    input: z.output<T>,
    context: ToolContext,
  ): Promise<unknown>;
}

const beforeExecutionErrors = new WeakSet<ToolError>();
export class ToolError extends Error {
  get executionStarted() { return !beforeExecutionErrors.has(this); }
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

function beforeExecutionError(code: string, message: string) {
  const error = new ToolError(code, message);
  beforeExecutionErrors.add(error);
  return error;
}

export class ToolRegistry {
  constructor(private readonly authorize?: (name: string, argumentsJson: string, context: ToolContext) => Promise<NonNullable<ToolContext["authorization"]>>) {}
  private async authorization(name: string, argumentsJson: string, context: ToolContext) {
    if (!this.authorize) throw beforeExecutionError("TOOL_FORBIDDEN", "Tool authorization is required");
    try { return await this.authorize(name, argumentsJson, context); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const known = typeof code === "string" && ["TOOL_FORBIDDEN", "AUDIT_UNAVAILABLE", "AUTHORIZATION_UNAVAILABLE"].includes(code);
      throw beforeExecutionError(known ? code : "AUTHORIZATION_UNAVAILABLE", "Tool authorization did not complete");
    }
  }
  private readonly tools = new Map<
    string,
    Tool<z.ZodTypeAny>
  >();

  register<T extends z.ZodTypeAny>(tool: Tool<T>): void {
    if (this.tools.has(tool.name)) {
      throw new ToolError(
        "DUPLICATE_TOOL",
        `Duplicate tool: ${tool.name}`,
      );
    }

    this.tools.set(tool.name, tool);
  }

  validCall(name:string,rawArguments:string):boolean {
    const tool=this.tools.get(name);if(!tool)return false;
    try{return tool.schema.safeParse(JSON.parse(rawArguments)).success;}catch{return false;}
  }
  isRetrySafe(name: string): boolean {
    return this.tools.get(name)?.retrySafe === true;
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  async execute(
    name: string,
    rawArguments: string,
    context: ToolContext = {},
  ): Promise<unknown> {
    const tool = this.tools.get(name);

    if (!tool) {
      if (this.authorize) await this.authorization(name, rawArguments, context);
      throw beforeExecutionError(
        "UNKNOWN_TOOL",
        `Unknown tool: ${name}`,
      );
    }

    if (context.signal?.aborted) {
      throw beforeExecutionError("CANCELLED", "Tool cancelled");
    }

    let args: unknown;

    try {
      args = JSON.parse(rawArguments);
    } catch {
      throw beforeExecutionError(
        "INVALID_ARGUMENTS",
        "Tool arguments are not valid JSON",
      );
    }

    const result = tool.schema.safeParse(args);

    if (!result.success) {
      throw beforeExecutionError(
        "INVALID_ARGUMENTS",
        "Tool arguments failed schema validation",
      );
    }

    const authorization = await this.authorization(name, rawArguments, context);
    if (context.signal?.aborted) throw beforeExecutionError("CANCELLED", "Tool cancelled");
    return tool.execute(result.data, { ...context, authorization });
  }
}