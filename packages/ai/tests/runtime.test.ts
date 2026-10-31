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
  vi.restoreAllMocks();
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

  it("records deadline even when the timer fires before the measured duration", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const deadline = createDeadline(20);
    try {
      expect(deadline.terminationReason).toBeNull();
      vi.advanceTimersByTime(20);
      expect(deadline.remainingMs()).toBe(20);
      expect(deadline.terminationReason?.code).toBe("DEADLINE_EXCEEDED");
      expect(deadline.signal.reason).toBe(deadline.terminationReason);
      expect(() => deadline.throwIfAborted()).toThrow(deadline.terminationReason!);
    } finally { deadline.dispose(); }
  });

  it("keeps an earlier user cancellation after the deadline has passed", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = createDeadline(20, parent.signal);
    try {
      parent.abort();
      const first = deadline.terminationReason;
      vi.advanceTimersByTime(21);
      expect(deadline.remainingMs()).toBe(0);
      expect(deadline.terminationReason).toBe(first);
      expect(first?.code).toBe("CANCELLED");
    } finally { deadline.dispose(); }
  });

  it("does not replace a deadline with a later parent cancellation", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = createDeadline(20, parent.signal);
    try {
      vi.advanceTimersByTime(20);
      const first = deadline.terminationReason;
      parent.abort(new RuntimeError("WORKER_STOPPED", "Worker stopped"));
      expect(deadline.terminationReason).toBe(first);
      expect(first?.code).toBe("DEADLINE_EXCEEDED");
    } finally { deadline.dispose(); }
  });

  it.each(["CANCELLED", "WORKER_STOPPED", "LEASE_LOST", "HEARTBEAT_FAILED"])(
    "preserves a pre-aborted parent reason: %s", (code) => {
      vi.useFakeTimers();
      const parent = new AbortController();
      const error = new RuntimeError(code, code);
      parent.abort(error);
      const deadline = createDeadline(20, parent.signal);
      try {
        vi.advanceTimersByTime(20);
        expect(deadline.terminationReason).toBe(error);
        expect(() => deadline.throwIfAborted()).toThrow(error);
      } finally { deadline.dispose(); }
    },
  );

  it.each(["parent", "deadline"])("uses the first callback when both fire in the same tick: %s first", (first) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    if (first === "parent") setTimeout(() => parent.abort(), 20);
    const deadline = createDeadline(20, parent.signal);
    if (first === "deadline") setTimeout(() => parent.abort(), 20);
    try {
      vi.advanceTimersByTime(20);
      expect(deadline.terminationReason?.code).toBe(first === "parent" ? "CANCELLED" : "DEADLINE_EXCEEDED");
    } finally { deadline.dispose(); }
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