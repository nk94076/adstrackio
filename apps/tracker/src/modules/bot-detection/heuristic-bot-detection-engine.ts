import type {
  BotClassificationInput,
  BotClassificationResult,
  BotDetectionEngine,
} from "@adstrackio/shared";

/**
 * Minimal, explicitly-provisional implementation of the BotDetectionEngine
 * boundary (packages/shared/src/bot-detection.ts), so the Phase 3 tracker
 * has something real to route on today. This is NOT the "existing/planned
 * bot-detection capability" Phase 5 is meant to wire in — it is a small,
 * honest user-agent heuristic, clearly isolated behind the same interface
 * so Phase 5 can replace it with a real engine without touching the
 * tracker route or the Click/BotEvent schema.
 *
 * Classification is 100% server-computed from the request's own User-Agent
 * header. There is no code path anywhere that lets a request parameter
 * (query string, header the client fully controls the meaning of, etc.)
 * assert its own bot/human status.
 */

const KNOWN_BOT_UA_PATTERNS = [
  /bot\b/i,
  /crawler/i,
  /spider/i,
  /curl\//i,
  /wget\//i,
  /python-requests/i,
  /python-urllib/i,
  /headlesschrome/i,
  /phantomjs/i,
  /facebookexternalhit/i,
  /googlebot/i,
  /bingbot/i,
  /slurp/i, // Yahoo
  /duckduckbot/i,
  /baiduspider/i,
  /yandexbot/i,
  /semrushbot/i,
  /ahrefsbot/i,
  /mj12bot/i,
  /petalbot/i,
  /go-http-client/i,
  /okhttp/i,
  /libwww-perl/i,
  /scrapy/i,
];

const DETECTION_SOURCE = "tracker-heuristic-placeholder";

export class HeuristicBotDetectionEngine implements BotDetectionEngine {
  classify(input: BotClassificationInput): Promise<BotClassificationResult> {
    const userAgent = input.userAgent?.trim();

    if (!userAgent) {
      return Promise.resolve({
        classification: "BOT",
        score: 0.9,
        reasonCodes: ["missing_user_agent"],
        detectionSource: DETECTION_SOURCE,
      });
    }

    const matched = KNOWN_BOT_UA_PATTERNS.find((pattern) => pattern.test(userAgent));
    if (matched) {
      return Promise.resolve({
        classification: "BOT",
        score: 0.9,
        reasonCodes: ["known_bot_user_agent"],
        detectionSource: DETECTION_SOURCE,
      });
    }

    return Promise.resolve({
      classification: "HUMAN",
      score: 0.5,
      reasonCodes: [],
      detectionSource: DETECTION_SOURCE,
    });
  }
}
