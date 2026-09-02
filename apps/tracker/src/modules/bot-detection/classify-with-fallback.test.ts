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
