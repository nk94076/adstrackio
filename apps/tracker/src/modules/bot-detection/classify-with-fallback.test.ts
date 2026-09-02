import { describe, expect, it } from "vitest";
import type { BotDetectionEngine } from "@adstrackio/shared";
import { classifyWithSafeFallback } from "./classify-with-fallback.js";

describe("classifyWithSafeFallback", () => {
  it("passes through a normal engine result unchanged", async () => {
    const engine: BotDetectionEngine = {
      classify: () =>
        Promise.resolve({
          classification: "HUMAN",
          score: 0,
          reasonCodes: [],
          detectionSource: "test-engine",
        }),
    };

    const result = await classifyWithSafeFallback(engine, { clickId: "c1" });
    expect(result).toEqual({
      classification: "HUMAN",
      score: 0,
      reasonCodes: [],
      detectionSource: "test-engine",
    });
  });

  it("passes a signal to the engine, and does not abort it on normal completion", async () => {
    let receivedSignal: AbortSignal | undefined;
    const engine: BotDetectionEngine = {
      classify: (input) => {
        receivedSignal = input.signal;
        return Promise.resolve({
          classification: "HUMAN",
          score: 0,
          reasonCodes: [],
          detectionSource: "test-engine",
        });
      },
    };

    await classifyWithSafeFallback(engine, { clickId: "c1" });

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
  });

  it("falls back to UNKNOWN when the engine throws synchronously", async () => {
    const engine: BotDetectionEngine = {
      classify: () => {
        throw new Error("boom: engine exploded synchronously");
      },
    };

    const result = await classifyWithSafeFallback(engine, { clickId: "c1" });
    expect(result.classification).toBe("UNKNOWN");
    expect(result.reasonCodes).toContain("detection_engine_failure");
    expect(result.detectionSource).toBe("tracker-fallback");
  });

  it("falls back to UNKNOWN when the engine's promise rejects", async () => {
    const engine: BotDetectionEngine = {
      classify: () => Promise.reject(new Error("boom: engine rejected")),
    };

    const result = await classifyWithSafeFallback(engine, { clickId: "c1" });
    expect(result.classification).toBe("UNKNOWN");
    expect(result.reasonCodes).toContain("detection_engine_failure");
  });

  it("falls back to UNKNOWN when the engine never resolves (timeout)", async () => {
    const engine: BotDetectionEngine = {
      classify: () => new Promise(() => {
        /* deliberately never settles */
      }),
    };

    const start = Date.now();
    const result = await classifyWithSafeFallback(engine, { clickId: "c1" });
    const elapsed = Date.now() - start;

    expect(result.classification).toBe("UNKNOWN");
    expect(result.reasonCodes).toContain("detection_engine_timeout");
    expect(result.detectionSource).toBe("tracker-fallback");
    // Bounded by the internal timeout (50ms) — generous margin for CI jitter,
    // but proves this doesn't hang indefinitely.
    expect(elapsed).toBeLessThan(1000);
  });

  it("aborts the signal passed to the engine when the timeout fires", async () => {
    let receivedSignal: AbortSignal | undefined;
    const engine: BotDetectionEngine = {
      classify: (input) => {
        receivedSignal = input.signal;
        // Never resolves on its own — only a well-behaved engine reacting
        // to the abort signal would ever settle this.
        return new Promise(() => {
          /* deliberately never settles */
        });
      },
    };

    const result = await classifyWithSafeFallback(engine, { clickId: "c1" });

    expect(result.classification).toBe("UNKNOWN");
    expect(result.reasonCodes).toContain("detection_engine_timeout");
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    // The timeout doesn't just stop waiting — it actually requests
    // cancellation of the underlying operation.
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("a well-behaved async engine that honors the signal can clean up when the timeout fires", async () => {
    let abortEventReceived = false;
    const engine: BotDetectionEngine = {
      classify: (input) =>
        new Promise((resolve) => {
          // Simulates a future network-backed engine: it does real
          // asynchronous work and listens for cancellation instead of
          // ignoring the signal like the current heuristic engine does.
          input.signal?.addEventListener("abort", () => {
            abortEventReceived = true;
            // A real engine would tear down its connection/request here;
            // it may still resolve (or reject) afterward, which
            // classifyWithSafeFallback must safely ignore since it has
            // already resolved via the timeout path.
            resolve({
              classification: "UNKNOWN",
              reasonCodes: ["cancelled"],
              detectionSource: "hypothetical-network-engine",
            });
          });
        }),
    };

    const result = await classifyWithSafeFallback(engine, { clickId: "c1" });

    expect(abortEventReceived).toBe(true);
    // classifyWithSafeFallback's own timeout result wins regardless of
    // what the engine does after being aborted.
    expect(result.classification).toBe("UNKNOWN");
    expect(result.reasonCodes).toContain("detection_engine_timeout");
    expect(result.detectionSource).toBe("tracker-fallback");
  });

  it("does not abort the signal when the engine throws synchronously (nothing left to cancel)", async () => {
    let receivedSignal: AbortSignal | undefined;
    const engine: BotDetectionEngine = {
      classify: (input) => {
        receivedSignal = input.signal;
        throw new Error("boom: engine exploded synchronously");
      },
    };

    await classifyWithSafeFallback(engine, { clickId: "c1" });

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
  });

  it("ignores a late resolution after the timeout has already fired", async () => {
    let resolveLate!: (value: {
      classification: "HUMAN";
      score: number;
      reasonCodes: string[];
      detectionSource: string;
    }) => void;
    const engine: BotDetectionEngine = {
      classify: () =>
        new Promise((resolve) => {
          resolveLate = resolve;
        }),
    };

    const result = await classifyWithSafeFallback(engine, { clickId: "c1" });
    expect(result.classification).toBe("UNKNOWN");

    // Resolving after the fact must not throw or affect anything already
    // returned — this just proves no dangling state causes a crash.
    expect(() =>
      resolveLate({ classification: "HUMAN", score: 0, reasonCodes: [], detectionSource: "late" }),
    ).not.toThrow();
  });
});
