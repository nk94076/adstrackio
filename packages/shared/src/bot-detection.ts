/**
 * Plug-in boundary for the product's existing/planned bot-detection engine
 * (Phase 5). AdstrackIO does not implement its own bot classification logic
 * here — this interface exists so a BotEvent can be written by whichever
 * engine is wired in later without changing the Click/BotEvent schema or
 * the API surface that consumes it.
 */
export type BotClassification = "UNKNOWN" | "HUMAN" | "SUSPICIOUS" | "BOT";

export interface BotClassificationInput {
  clickId: string;
  userAgent?: string;
  ipHash?: string;
  requestMetadata?: Record<string, unknown>;
}

export interface BotClassificationResult {
  classification: BotClassification;
  score?: number;
  reasonCodes: string[];
  detectionSource: string;
}

export interface BotDetectionEngine {
  classify(input: BotClassificationInput): Promise<BotClassificationResult>;
}
