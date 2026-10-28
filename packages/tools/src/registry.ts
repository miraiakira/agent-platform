import { z } from "zod";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  signal?: AbortSignal;
}

export interface Tool<T extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: T;
  parameters: Record<string, unknown>;
  execute(
    input: z.output<T>,
    context: ToolContext,
  ): Promise<unknown>;
}

export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export class ToolRegistry {
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
      throw new ToolError(
        "UNKNOWN_TOOL",
        `Unknown tool: ${name}`,
      );
    }

    if (context.signal?.aborted) {
      throw new ToolError("CANCELLED", "Tool cancelled");
    }

    let args: unknown;

    try {
      args = JSON.parse(rawArguments);
    } catch {
      throw new ToolError(
        "INVALID_ARGUMENTS",
        "Tool arguments are not valid JSON",
      );
    }

    const result = tool.schema.safeParse(args);

    if (!result.success) {
      throw new ToolError(
        "INVALID_ARGUMENTS",
        "Tool arguments failed schema validation",
      );
    }

    return tool.execute(result.data, context);
  }
}