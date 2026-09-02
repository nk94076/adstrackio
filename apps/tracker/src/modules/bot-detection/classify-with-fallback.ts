import type { BotClassificationResult, BotDetectionEngine, BotDetectionInput } from "@adstrackio/shared";

/**
 * Wraps BotDetectionEngine.classify with the same "never let this fail the
 * redirect" guarantee already established for UA parsing and geo lookup
 * (apps/tracker/src/modules/tracker/tracker.service.ts). Bot detection sits
 * squarely on the hot path — unlike geo enrichment, its result gates the
 * routing decision itself, so it can't simply be deferred to the
 * background — so both failure modes below resolve to a safe fallback
 * instead of propagating:
 *
 * - A throw or a rejected promise from the engine (a bug in the engine, or
 *   — for a future network-backed engine — a connection error).
 * - The engine taking longer than CLASSIFY_TIMEOUT_MS to resolve at all.
 *   The current HeuristicBotDetectionEngine is fully synchronous/local and
 *   will never hit this in practice, but the guard costs nothing on that
 *   path and protects against a future engine that hangs instead of
 *   rejecting — a hang would otherwise stall the redirect indefinitely,
 *   which is worse than a crash.
 *
 * The fallback classification is UNKNOWN, not HUMAN or BOT: a detection
 * failure is not evidence of humanity (never trust that) and not evidence
 * of automation either (never guess BOT without a real signal) — it's
 * exactly what UNKNOWN means, and it's routed through the campaign's own
 * configured unknownTrafficPolicy like any other UNKNOWN verdict, not a
 * special case.
 *
 * CANCELLATION: a 50ms timeout that only stops *waiting* on the engine
 * would leave its promise (and whatever work produces it — a socket, a
 * worker, an in-flight request) running in the background indefinitely.
 * Under sustained high traffic against a future slow/hanging network-backed
 * engine, that accumulates unbounded outstanding work even though every
 * individual redirect still completes on time — a real resource-exhaustion
 * risk. So this creates one `AbortController` per call, passes its
 * `signal` into `engine.classify()` as part of the input, and calls
 * `controller.abort()` exactly when the timeout fires (never on a normal
 * resolution or an engine-thrown rejection, both of which have already
 * settled on their own — there is nothing left to cancel). See
 * `BotDetectionInput.signal` (packages/shared/src/bot-detection.ts) for
 * the contract this places on any future engine: it MUST observe the
 * signal and actually tear down its underlying operation, not merely
 * "stop mattering." The current `HeuristicBotDetectionEngine` is
 * synchronous/local and has nothing to cancel, so it safely ignores the
 * signal — passing it costs nothing.
 */
const CLASSIFY_TIMEOUT_MS = 50;

function fallbackResult(reasonCode: string): BotClassificationResult {
  return {
    classification: "UNKNOWN",
    reasonCodes: [reasonCode],
    detectionSource: "tracker-fallback",
  };
}

export function classifyWithSafeFallback(
  engine: BotDetectionEngine,
  input: BotDetectionInput,
): Promise<BotClassificationResult> {
  const controller = new AbortController();

  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Request cancellation of the underlying operation, not just
      // "stop waiting for it" — see the module doc comment above.
      controller.abort();
      resolve(fallbackResult("detection_engine_timeout"));
    }, CLASSIFY_TIMEOUT_MS);

    Promise.resolve()
      .then(() => engine.classify({ ...input, signal: controller.signal }))
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallbackResult("detection_engine_failure"));
      });
  });
}
