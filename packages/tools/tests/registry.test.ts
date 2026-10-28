import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ToolRegistry } from "../src";

function createRegistry() {
  const registry = new ToolRegistry();
  const execute = vi.fn(async (input: { limit: number }) => ({
    count: input.limit,
  }));

  registry.register({
    name: "test_tool",
    description: "Test tool",
    schema: z.object({
      limit: z.number().int().min(1).max(5),
    }).strict(),
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer" },
      },
      required: ["limit"],
      additionalProperties: false,
    },
    execute,
  });

  return { registry, execute };
}

describe("ToolRegistry", () => {
  it("executes valid tool calls", async () => {
    const { registry, execute } = createRegistry();

    await expect(
      registry.execute("test_tool", '{"limit":3}'),
    ).resolves.toEqual({ count: 3 });

    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects unknown tools", async () => {
    const { registry } = createRegistry();

    await expect(
      registry.execute("unknown", "{}"),
    ).rejects.toMatchObject({
      code: "UNKNOWN_TOOL",
    });
  });

  it("rejects invalid JSON", async () => {
    const { registry, execute } = createRegistry();

    await expect(
      registry.execute("test_tool", "{invalid"),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS",
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects invalid arguments", async () => {
    const { registry, execute } = createRegistry();

    await expect(
      registry.execute("test_tool", '{"limit":100}'),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS",
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects duplicate registrations", () => {
    const { registry } = createRegistry();

    expect(() =>
      registry.register({
        name: "test_tool",
        description: "Duplicate",
        schema: z.object({}),
        parameters: { type: "object" },
        execute: async () => null,
      }),
    ).toThrow("Duplicate tool");
  });

  it("rejects pre-cancelled execution", async () => {
    const { registry, execute } = createRegistry();

    await expect(
      registry.execute(
        "test_tool",
        '{"limit":3}',
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });

    expect(execute).not.toHaveBeenCalled();
  });
});