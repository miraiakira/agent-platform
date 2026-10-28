import { z } from "zod";
import {
  ToolError,
  ToolRegistry,
} from "./registry";

const inputSchema = z.object({
  date: z.iso.date(),
  limit: z.number().int().min(1).max(20),
}).strict();

const responseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      amount: z.number(),
      currency: z.string(),
      risk_score: z.number(),
      risk_level: z.string(),
      risk_reason: z.string(),
      created_at: z.string(),
    }),
  ),
  total: z.number().int(),
});

export function createBusinessTools(config: {
  baseURL: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): ToolRegistry {
  const registry = new ToolRegistry();
  const fetchImpl = config.fetchImpl ?? fetch;

  registry.register({
    name: "get_high_risk_transactions",
    description:
      "Query high-risk transactions for a UTC date, sorted by descending risk score. Returns at most the requested number of transactions.",
    schema: inputSchema,

    parameters: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "UTC date in YYYY-MM-DD format",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum number of transactions",
        },
      },
      required: ["date", "limit"],
      additionalProperties: false,
    },

    async execute(input, context) {
      const url = new URL(
        "/api/transactions/high-risk",
        config.baseURL,
      );

      url.searchParams.set("date", input.date);
      url.searchParams.set("limit", String(input.limit));

      let response: Response;

      try {
        response = await fetchImpl(url, {
          headers: config.apiKey
            ? { Authorization: `Bearer ${config.apiKey}` }
            : undefined,
          signal: context.signal,
        });
      } catch {
        if (context.signal?.aborted) {
          throw new ToolError("CANCELLED", "Tool cancelled");
        }

        throw new ToolError(
          "UPSTREAM_ERROR",
          "Business API is unavailable",
        );
      }

      if (!response.ok) {
        throw new ToolError(
          "UPSTREAM_ERROR",
          `Business API returned HTTP ${response.status}`,
        );
      }

      const payload: unknown = await response.json();
      const parsed = responseSchema.safeParse(payload);

      if (!parsed.success) {
        throw new ToolError(
          "INVALID_RESULT",
          "Business API returned invalid data",
        );
      }

      return parsed.data;
    },
  });

  return registry;
}