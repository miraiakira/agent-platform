import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createDeadline,
  RuntimeError,
} from "../src/runtime";

import {
  serializeLimited,
} from "../src/tool-execution";

afterEach(() => {
  vi.useRealTimers();
});

describe("Execution Runtime", () => {
  it("enforces global deadline", () => {
    vi.useFakeTimers();

    const deadline = createDeadline(100);

    vi.advanceTimersByTime(101);

    expect(() =>
      deadline.throwIfAborted(),
    ).toThrowError(RuntimeError);

    expect(() =>
      deadline.throwIfAborted(),
    ).toThrow(
      "Agent deadline exceeded",
    );

    deadline.dispose();
  });

  it("propagates user cancellation", () => {
    const controller = new AbortController();

    const deadline = createDeadline(
      60_000,
      controller.signal,
    );

    controller.abort();

    expect(deadline.signal.aborted).toBe(true);

    expect(() =>
    deadline.throwIfAborted(),
    ).toThrow("Agent cancelled");

    deadline.dispose();
  });

  it("accepts tool results within byte limit", () => {
    const result = serializeLimited(
      { ok: true },
      1024,
    );

    expect(JSON.parse(result)).toEqual({
      ok: true,
    });
  });

  it("rejects oversized UTF-8 tool results", () => {
    expect(() =>
      serializeLimited(
        { text: "你好".repeat(100) },
        100,
      ),
    ).toThrow(
      "Tool result exceeds",
    );
  });
});