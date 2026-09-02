import { describe, expect, it } from "vitest";
import { HeuristicBotDetectionEngine } from "./heuristic-bot-detection-engine.js";

describe("HeuristicBotDetectionEngine", () => {
  const engine = new HeuristicBotDetectionEngine();

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
    "curl/8.4.0",
    "Wget/1.21.3",
    "python-requests/2.31.0",
    "python-urllib/3.11",
    "Scrapy/2.11.0 (+https://scrapy.org)",
    "Go-http-client/1.1",
    "okhttp/4.9.0",
    "libwww-perl/6.68",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) HeadlessChrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (compatible; PhantomJS/2.1.1)",
    "facebookexternalhit/1.1",
    "SomeGenericCrawler/1.0",
    "AnySpiderBot/1.0",
    "GenericBot/1.0",
  ])("classifies known automated user agent as BOT: %s", async (userAgent) => {
    const result = await engine.classify({ clickId: "c1", userAgent });
    expect(result.classification).toBe("BOT");
    expect(result.detectionSource).toBe("tracker-heuristic-placeholder");
  });

  it("classifies an empty user agent as BOT", async () => {
    const result = await engine.classify({ clickId: "c1", userAgent: "" });
    expect(result.classification).toBe("BOT");
    expect(result.reasonCodes).toContain("missing_user_agent");
  });

  it("classifies a missing user agent as BOT", async () => {
    const result = await engine.classify({ clickId: "c1" });
    expect(result.classification).toBe("BOT");
    expect(result.reasonCodes).toContain("missing_user_agent");
  });

  it.each([
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
  ])("classifies a real browser user agent as HUMAN: %s", async (userAgent) => {
    const result = await engine.classify({ clickId: "c1", userAgent });
    expect(result.classification).toBe("HUMAN");
  });

  it("never lets requestMetadata or any other input field override the UA-derived classification", async () => {
    const result = await engine.classify({
      clickId: "c1",
      userAgent: "Googlebot/2.1",
      requestMetadata: { isBot: false, classification: "HUMAN" },
    });
    expect(result.classification).toBe("BOT");
  });
});
