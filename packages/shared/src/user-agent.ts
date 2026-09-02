/**
 * Plug-in boundary for User-Agent-derived analytics enrichment
 * (Phase 4: Click Analytics). Mirrors the existing TrackingResolver /
 * BotDetectionEngine pattern: the interface lives here, a concrete
 * implementation lives in apps/tracker (UaParserUserAgentParser).
 *
 * Scope note: this is an ANALYTICS concern only — it answers "what kind of
 * device/browser/OS is this, for reporting purposes." It must never be
 * used for bot/human classification; that remains BotDetectionEngine's
 * job exclusively (packages/shared/src/bot-detection.ts). A parser
 * implementation is expected to be a pure, synchronous, no-I/O function —
 * parsing a User-Agent string is a local string-matching operation, never
 * a network call — so a failure here is a bug in the input, not something
 * that should ever block a click write or a redirect. Callers should wrap
 * `parse` in a try/catch regardless and treat any failure as "unknown."
 */

/** Mirrors the Prisma `DeviceType` enum's values without importing
 * @adstrackio/database — packages/shared has no dependency on the
 * database package, matching the existing BotClassification precedent
 * in bot-detection.ts. */
export type AnalyticsDeviceType = "UNKNOWN" | "DESKTOP" | "MOBILE" | "TABLET" | "BOT" | "OTHER";

export interface DeviceInfo {
  deviceType: AnalyticsDeviceType;
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  osVersion: string | null;
}

export const UNKNOWN_DEVICE_INFO: DeviceInfo = {
  deviceType: "UNKNOWN",
  browser: null,
  browserVersion: null,
  os: null,
  osVersion: null,
};

export interface UserAgentParser {
  parse(userAgent: string | null | undefined): DeviceInfo;
}
