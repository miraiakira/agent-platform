import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { z } from "zod";

import {
  ToolError,
  ToolRegistry,
} from "@eap/tools";

import {
  executeToolWithPolicy,
} from "../src/tool-execution";

import { DEFAULT_BUDGET } from "../src/runtime";

function registryWith(
  execute: () => Promise<unknown>,
  retrySafe = true,
) {
  const registry = new ToolRegistry();

  registry.register({
    name: "test",
    retrySafe,
    description: "Test tool",
    schema: z.object({}).strict(),
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute,
  });

  return registry;
}

const options = () => ({
  signal: new AbortController().signal,
  budget: DEFAULT_BUDGET,
  remainingMs: () => 60_000,
});

describe("Tool execution policy", () => {
  it("retries transient upstream errors once", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(
        new ToolError(
          "UPSTREAM_ERROR",
          "Temporary failure",
        ),
      )
      .mockResolvedValueOnce({ ok: true });

    const result = await executeToolWithPolicy(
      registryWith(execute),
      "test",
      "{}",
      options(),
    );

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("never retries tools without an explicit retry safety declaration", async () => {
    const execute = vi.fn().mockRejectedValue(new ToolError("UPSTREAM_ERROR", "Outcome unknown"));
    const result = await executeToolWithPolicy(registryWith(execute, false), "test", "{}", options());
    expect(result.success).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns on timeout even when a tool ignores abort, without retrying it", async () => {
    const execute = vi.fn(() => new Promise(() => {}));
    const result = await executeToolWithPolicy(registryWith(execute, false), "test", "{}", {
      ...options(), budget: { ...DEFAULT_BUDGET, maxToolDurationMs: 10 },
    });
    expect(result.errorCode).toBe("TOOL_TIMEOUT");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not retry invalid arguments", async () => {
    const execute = vi.fn()
      .mockResolvedValue({ ok: true });

    const result = await executeToolWithPolicy(
      registryWith(execute),
      "test",
      "{invalid}",
      options(),
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(
      "INVALID_ARGUMENTS",
    );
    expect(result.attempts).toBe(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects oversized tool output", async () => {
    const execute = vi.fn()
      .mockResolvedValue({
        text: "A".repeat(1000),
      });

    const result = await executeToolWithPolicy(
      registryWith(execute),
      "test",
      "{}",
      {
        ...options(),
        budget: {
          ...DEFAULT_BUDGET,
          maxToolResultBytes: 100,
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(
      "TOOL_RESULT_TOO_LARGE",
    );
    expect(execute).toHaveBeenCalledOnce();
  });
});