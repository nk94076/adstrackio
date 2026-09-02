import type {
  BotClassification,
  BotClassificationResult,
  BotDetectionEngine,
  BotDetectionHeaderSignals,
  BotDetectionInput,
} from "@adstrackio/shared";

/**
 * Multi-signal, weighted-scoring implementation of the BotDetectionEngine
 * boundary (packages/shared/src/bot-detection.ts).
 *
 * HONESTY NOTE (read before extending this file): this is a PROVISIONAL /
 * HEURISTIC detector, not a production-grade or ML-based bot-detection
 * system, and it is not claimed to be either. It combines a small number
 * of deterministic, locally-computable signals — known bot/automation
 * User-Agent strings, and HTTP-header consistency for UAs that claim to be
 * a mainstream browser — into a bounded 0..1 score, then maps that score
 * to one of the four BotClassification values. It will misclassify real
 * traffic in both directions under adversarial conditions (a sufficiently
 * careful script can mimic every signal checked here; a real browser
 * behind an unusual proxy/extension setup can trip the header-consistency
 * signal). See docs/architecture/bot-detection.md for the full scoring
 * model, its rationale, and what a future non-heuristic engine would need
 * to add.
 *
 * Every signal is computed entirely from server-observed request data
 * (the User-Agent header and a small, explicit set of other headers) —
 * there is no code path anywhere that lets a request parameter (query
 * string, a header the client fully controls the meaning of, etc.) assert
 * its own bot/human status or influence the score directly.
 */

const DETECTION_SOURCE = "tracker-heuristic-placeholder";

// Search-engine / SEO / monitoring crawlers. Distinguished from the HTTP
// client and headless-browser lists below purely for clearer reasonCodes —
// all three carry the same weight today, but a future engine (or an
// analyst reading BotEvent.reasonCodes) may reasonably want to treat them
// differently.
const CRAWLER_UA_PATTERNS = [
  /bot\b/i,
  /crawler/i,
  /spider/i,
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
  /facebookexternalhit/i,
];

// Non-browser HTTP client libraries — legitimate for API use, but never a
// real end-user click through an ad/affiliate link.
const HTTP_CLIENT_UA_PATTERNS = [
  /curl\//i,
  /wget\//i,
  /python-requests/i,
  /python-urllib/i,
  /go-http-client/i,
  /okhttp/i,
  /libwww-perl/i,
  /scrapy/i,
];

// Headless/automated-browser runtimes.
const HEADLESS_BROWSER_UA_PATTERNS = [
  /headlesschrome/i,
  /phantomjs/i,
  /puppeteer/i,
  /playwright/i,
  /selenium/i,
];

// UAs that claim to be a mainstream, interactive browser — used only to
// decide whether the header-consistency signal below applies. Matching
// this list is NOT itself a signal in either direction.
const BROWSER_UA_PATTERNS = [/chrome\//i, /firefox\//i, /safari\//i, /edg\//i, /opr\//i];

/** Weights are a bot-likelihood contribution on a 0..1 scale, chosen so
 * that any single "known automation" UA match alone crosses the BOT
 * threshold, while the softer header-consistency signals only cross it in
 * combination — see CLASSIFICATION_THRESHOLDS below and
 * docs/architecture/bot-detection.md for the full rationale. */
const SIGNAL_WEIGHTS = {
  knownCrawlerUserAgent: 0.9,
  knownHttpClientUserAgent: 0.9,
  knownHeadlessBrowserUserAgent: 0.9,
  missingSecFetchHeadersOnBrowserUa: 0.35,
  missingAcceptHeader: 0.2,
  missingAcceptLanguageHeader: 0.15,
} as const;

const CLASSIFICATION_THRESHOLDS = {
  bot: 0.75,
  suspicious: 0.35,
  // Anything above 0 but below `suspicious` is UNKNOWN; exactly 0 is HUMAN.
} as const;

function scoreUserAgentSignals(userAgent: string): { score: number; reasonCodes: string[] } {
  if (CRAWLER_UA_PATTERNS.some((pattern) => pattern.test(userAgent))) {
    return { score: SIGNAL_WEIGHTS.knownCrawlerUserAgent, reasonCodes: ["known_crawler_user_agent"] };
  }
  if (HTTP_CLIENT_UA_PATTERNS.some((pattern) => pattern.test(userAgent))) {
    return {
      score: SIGNAL_WEIGHTS.knownHttpClientUserAgent,
      reasonCodes: ["known_http_client_user_agent"],
    };
  }
  if (HEADLESS_BROWSER_UA_PATTERNS.some((pattern) => pattern.test(userAgent))) {
    return {
      score: SIGNAL_WEIGHTS.knownHeadlessBrowserUserAgent,
      reasonCodes: ["known_headless_browser_user_agent"],
    };
  }
  return { score: 0, reasonCodes: [] };
}

/**
 * Every mainstream browser (Chrome, Firefox, Safari, Edge) has sent
 * `Sec-Fetch-*` headers on top-level navigations by default since ~2021,
 * and always sends `Accept`/`Accept-Language`. A script that spoofs a
 * browser's User-Agent string but doesn't bother replicating its full
 * header set is a genuine, if soft, sign the "browser" isn't a browser.
 * This never fires for a UA that isn't claiming to be a mainstream
 * browser in the first place — an unrecognized custom UA with no headers
 * still only accumulates the two generic missing-header signals below.
 */
function scoreHeaderConsistency(
  userAgent: string,
  headers: BotDetectionHeaderSignals | undefined,
): { score: number; reasonCodes: string[] } {
  let score = 0;
  const reasonCodes: string[] = [];

  const claimsToBeBrowser = BROWSER_UA_PATTERNS.some((pattern) => pattern.test(userAgent));
  const hasSecFetchHeaders = Boolean(
    headers?.secFetchMode ?? headers?.secFetchSite ?? headers?.secFetchDest,
  );
  if (claimsToBeBrowser && !hasSecFetchHeaders) {
    score += SIGNAL_WEIGHTS.missingSecFetchHeadersOnBrowserUa;
    reasonCodes.push("missing_sec_fetch_headers_on_browser_ua");
  }

  if (!headers?.accept) {
    score += SIGNAL_WEIGHTS.missingAcceptHeader;
    reasonCodes.push("missing_accept_header");
  }
  if (!headers?.acceptLanguage) {
    score += SIGNAL_WEIGHTS.missingAcceptLanguageHeader;
    reasonCodes.push("missing_accept_language_header");
  }

  return { score, reasonCodes };
}

function classificationForScore(score: number): BotClassification {
  if (score >= CLASSIFICATION_THRESHOLDS.bot) return "BOT";
  if (score >= CLASSIFICATION_THRESHOLDS.suspicious) return "SUSPICIOUS";
  if (score > 0) return "UNKNOWN";
  return "HUMAN";
}

export class HeuristicBotDetectionEngine implements BotDetectionEngine {
  classify(input: BotDetectionInput): Promise<BotClassificationResult> {
    const userAgent = input.userAgent?.trim();

    if (!userAgent) {
      return Promise.resolve({
        classification: "BOT",
        score: 1,
        reasonCodes: ["missing_user_agent"],
        detectionSource: DETECTION_SOURCE,
      });
    }

    const uaSignals = scoreUserAgentSignals(userAgent);
    const headerSignals = scoreHeaderConsistency(userAgent, input.headers);

    const score = Math.min(uaSignals.score + headerSignals.score, 1);
    const reasonCodes = [...uaSignals.reasonCodes, ...headerSignals.reasonCodes];

    return Promise.resolve({
      classification: classificationForScore(score),
      score,
      reasonCodes,
      detectionSource: DETECTION_SOURCE,
    });
  }
}
