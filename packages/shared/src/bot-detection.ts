/**
 * Plug-in boundary for the product's bot/automated-traffic detection
 * engine. This interface is the single source of truth for classification
 * — apps/tracker must never compute a second, independent verdict outside
 * whatever engine is wired in here (see
 * apps/tracker/src/modules/bot-detection/heuristic-bot-detection-engine.ts
 * for the current, explicitly-provisional implementation, and
 * docs/architecture/bot-detection.md for the full architecture).
 */
export type BotClassification = "UNKNOWN" | "HUMAN" | "SUSPICIOUS" | "BOT";

/**
 * Safe, minimal subset of request headers relevant to detection — never
 * the full raw header set. Each is optional because the underlying header
 * may genuinely be absent from the request; absence itself can be a
 * detection signal (see the heuristic engine), so `undefined` here must
 * always mean "this header was not present," not "not collected."
 */
export interface BotDetectionHeaderSignals {
  accept?: string;
  acceptLanguage?: string;
  secFetchMode?: string;
  secFetchSite?: string;
  secFetchDest?: string;
}

export interface BotDetectionInput {
  clickId: string;
  userAgent?: string;
  /** One-way hash of the request IP (see packages/shared/src/ip-hash.ts) —
   * never the raw IP. Not used by the current heuristic engine; kept as a
   * forward-compatible input for a future IP-reputation-style signal. */
  ipHash?: string;
  headers?: BotDetectionHeaderSignals;
  requestMetadata?: Record<string, unknown>;
}

export interface BotClassificationResult {
  classification: BotClassification;
  score?: number;
  reasonCodes: string[];
  detectionSource: string;
}

export interface BotDetectionEngine {
  classify(input: BotDetectionInput): Promise<BotClassificationResult>;
}
