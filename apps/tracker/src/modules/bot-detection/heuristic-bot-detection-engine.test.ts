import { describe, expect, it } from "vitest";
import type { BotDetectionHeaderSignals } from "@adstrackio/shared";
import { HeuristicBotDetectionEngine } from "./heuristic-bot-detection-engine.js";

/** Headers a real Chrome/Firefox/Safari send by default on a top-level
 * navigation — used to represent "a genuine, fully-formed browser
 * request" in tests, since the engine's header-consistency signal treats
 * their absence as a (soft) sign of automation. */
const REALISTIC_BROWSER_HEADERS: BotDetectionHeaderSignals = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  acceptLanguage: "en-US,en;q=0.9",
  secFetchMode: "navigate",
  secFetchSite: "none",
  secFetchDest: "document",
};

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

describe("HeuristicBotDetectionEngine", () => {
  const engine = new HeuristicBotDetectionEngine();

  describe("known automated User-Agent strings — always BOT regardless of headers", () => {
    it.each([
      "Googlebot/2.1 (+http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      "Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)",
      "DuckDuckBot/1.1",
      "Baiduspider+(+http://www.baidu.com/search/spider.htm)",
      "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
      "Mozilla/5.0 (compatible; SemrushBot/7~bl)",
      "Mozilla/5.0 (compatible; AhrefsBot/7.0)",
      "Mozilla/5.0 (compatible; MJ12bot/v1.4.8)",
      "Mozilla/5.0 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)",
      "facebookexternalhit/1.1",
      "SomeGenericCrawler/1.0",
      "AnySpiderBot/1.0",
      "GenericBot/1.0",
    ])("classifies known crawler user agent as BOT: %s", async (userAgent) => {
      const result = await engine.classify({ clickId: "c1", userAgent });
      expect(result.classification).toBe("BOT");
      expect(result.reasonCodes).toContain("known_crawler_user_agent");
      expect(result.detectionSource).toBe("tracker-heuristic-placeholder");
    });

    it.each([
      "curl/8.4.0",
      "Wget/1.21.3",
      "python-requests/2.31.0",
      "python-urllib/3.11",
      "Scrapy/2.11.0 (+https://scrapy.org)",
      "Go-http-client/1.1",
      "okhttp/4.9.0",
      "libwww-perl/6.68",
    ])("classifies known HTTP client user agent as BOT: %s", async (userAgent) => {
      const result = await engine.classify({ clickId: "c1", userAgent });
      expect(result.classification).toBe("BOT");
      expect(result.reasonCodes).toContain("known_http_client_user_agent");
      expect(result.detectionSource).toBe("tracker-heuristic-placeholder");
    });

    it.each([
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) HeadlessChrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (compatible; PhantomJS/2.1.1)",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Puppeteer/21.0.0",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Playwright/1.40.0",
      "Mozilla/5.0 (X11; Linux x86_64) selenium-webdriver/4.16.0",
    ])("classifies known headless/automation-runtime user agent as BOT: %s", async (userAgent) => {
      const result = await engine.classify({ clickId: "c1", userAgent });
      expect(result.classification).toBe("BOT");
      expect(result.reasonCodes).toContain("known_headless_browser_user_agent");
      expect(result.detectionSource).toBe("tracker-heuristic-placeholder");
    });
  });

  describe("missing User-Agent", () => {
    it("classifies an empty user agent as BOT", async () => {
      const result = await engine.classify({ clickId: "c1", userAgent: "" });
      expect(result.classification).toBe("BOT");
      expect(result.score).toBe(1);
      expect(result.reasonCodes).toContain("missing_user_agent");
    });

    it("classifies a missing user agent as BOT", async () => {
      const result = await engine.classify({ clickId: "c1" });
      expect(result.classification).toBe("BOT");
      expect(result.reasonCodes).toContain("missing_user_agent");
    });

    it("classifies a whitespace-only user agent as BOT (malformed input)", async () => {
      const result = await engine.classify({ clickId: "c1", userAgent: "   " });
      expect(result.classification).toBe("BOT");
      expect(result.reasonCodes).toContain("missing_user_agent");
    });
  });

  describe("genuine browser traffic — HUMAN only with a fully consistent header set", () => {
    it.each([
      CHROME_UA,
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
    ])("classifies a real browser user agent with a full header set as HUMAN: %s", async (userAgent) => {
      const result = await engine.classify({
        clickId: "c1",
        userAgent,
        headers: REALISTIC_BROWSER_HEADERS,
      });
      expect(result.classification).toBe("HUMAN");
      expect(result.score).toBe(0);
      expect(result.reasonCodes).toEqual([]);
    });

    it("classifies an unrecognized custom user agent with a full header set as HUMAN (avoids false positives)", async () => {
      const result = await engine.classify({
        clickId: "c1",
        userAgent: "MyCompanyInAppBrowser/3.2",
        headers: REALISTIC_BROWSER_HEADERS,
      });
      expect(result.classification).toBe("HUMAN");
    });
  });

  describe("header-consistency signal (suspicious / unknown territory)", () => {
    it("classifies a browser UA with no headers at all as SUSPICIOUS, not HUMAN or BOT", async () => {
      const result = await engine.classify({ clickId: "c1", userAgent: CHROME_UA });
      expect(result.classification).toBe("SUSPICIOUS");
      expect(result.reasonCodes).toEqual(
        expect.arrayContaining([
          "missing_sec_fetch_headers_on_browser_ua",
          "missing_accept_header",
          "missing_accept_language_header",
        ]),
      );
    });

    it("classifies a browser UA missing only sec-fetch headers as SUSPICIOUS (single 0.35 signal at the threshold)", async () => {
      const result = await engine.classify({
        clickId: "c1",
        userAgent: CHROME_UA,
        headers: { accept: REALISTIC_BROWSER_HEADERS.accept, acceptLanguage: REALISTIC_BROWSER_HEADERS.acceptLanguage },
      });
      expect(result.classification).toBe("SUSPICIOUS");
      expect(result.reasonCodes).toEqual(["missing_sec_fetch_headers_on_browser_ua"]);
      expect(result.score).toBeCloseTo(0.35);
    });

    it("classifies a browser UA missing only Accept as UNKNOWN (single weak 0.2 signal, below the SUSPICIOUS threshold)", async () => {
      const result = await engine.classify({
        clickId: "c1",
        userAgent: CHROME_UA,
        headers: {
          acceptLanguage: REALISTIC_BROWSER_HEADERS.acceptLanguage,
          secFetchMode: REALISTIC_BROWSER_HEADERS.secFetchMode,
        },
      });
      expect(result.classification).toBe("UNKNOWN");
      expect(result.reasonCodes).toEqual(["missing_accept_header"]);
      expect(result.score).toBeCloseTo(0.2);
    });

    it("classifies a browser UA missing only Accept-Language as UNKNOWN (single weak 0.15 signal)", async () => {
      const result = await engine.classify({
        clickId: "c1",
        userAgent: CHROME_UA,
        headers: {
          accept: REALISTIC_BROWSER_HEADERS.accept,
          secFetchMode: REALISTIC_BROWSER_HEADERS.secFetchMode,
        },
      });
      expect(result.classification).toBe("UNKNOWN");
      expect(result.reasonCodes).toEqual(["missing_accept_language_header"]);
      expect(result.score).toBeCloseTo(0.15);
    });

    it("combines two weak signals (0.2 + 0.15) to exactly cross the SUSPICIOUS threshold", async () => {
      const result = await engine.classify({
        clickId: "c1",
        userAgent: "MyCompanyInAppBrowser/3.2", // not a "browser" UA, so no sec-fetch signal applies
        headers: {},
      });
      expect(result.classification).toBe("SUSPICIOUS");
      expect(result.score).toBeCloseTo(0.35);
    });

    it("does not apply the sec-fetch signal to a non-browser-claiming UA", async () => {
      const result = await engine.classify({
        clickId: "c1",
        userAgent: "MyCompanyInAppBrowser/3.2",
        headers: { accept: REALISTIC_BROWSER_HEADERS.accept, acceptLanguage: REALISTIC_BROWSER_HEADERS.acceptLanguage },
      });
      expect(result.classification).toBe("HUMAN");
      expect(result.reasonCodes).toEqual([]);
    });
  });

  describe("conflicting signals", () => {
    it("a known-bot UA with a fully browser-consistent header set still classifies BOT (strong signal dominates)", async () => {
      const result = await engine.classify({
        clickId: "c1",
        userAgent: "Googlebot/2.1 (+http://www.google.com/bot.html)",
        headers: REALISTIC_BROWSER_HEADERS,
      });
      expect(result.classification).toBe("BOT");
      expect(result.reasonCodes).toContain("known_crawler_user_agent");
    });

    it("client-supplied requestMetadata can never override the computed classification", async () => {
      const result = await engine.classify({
        clickId: "c1",
        userAgent: "Googlebot/2.1",
        requestMetadata: { isBot: false, classification: "HUMAN", score: 0 },
      });
      expect(result.classification).toBe("BOT");
    });
  });

  describe("classification scoring and thresholds", () => {
    it("clamps a score that would otherwise exceed 1 (known bot UA + all header signals)", async () => {
      const result = await engine.classify({ clickId: "c1", userAgent: "curl/8.4.0", headers: {} });
      expect(result.score).toBeLessThanOrEqual(1);
    });

    it("scores a fully clean human request at exactly 0", async () => {
      const result = await engine.classify({
        clickId: "c1",
        userAgent: CHROME_UA,
        headers: REALISTIC_BROWSER_HEADERS,
      });
      expect(result.score).toBe(0);
    });
  });

  describe("AbortSignal (cancellation contract)", () => {
    it("accepts an AbortSignal without changing its classification (synchronous/local — nothing to cancel)", async () => {
      const controller = new AbortController();
      const result = await engine.classify({
        clickId: "c1",
        userAgent: CHROME_UA,
        headers: REALISTIC_BROWSER_HEADERS,
        signal: controller.signal,
      });
      expect(result.classification).toBe("HUMAN");
    });

    it("does not itself abort the signal it's given", async () => {
      const controller = new AbortController();
      await engine.classify({
        clickId: "c1",
        userAgent: CHROME_UA,
        headers: REALISTIC_BROWSER_HEADERS,
        signal: controller.signal,
      });
      expect(controller.signal.aborted).toBe(false);
    });

    it("still classifies correctly if the signal is already aborted before the call (never reads it)", async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await engine.classify({
        clickId: "c1",
        userAgent: "Googlebot/2.1",
        signal: controller.signal,
      });
      expect(result.classification).toBe("BOT");
    });
  });
});
