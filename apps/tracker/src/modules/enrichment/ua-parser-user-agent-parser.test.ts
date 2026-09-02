import { describe, expect, it } from "vitest";
import { UaParserUserAgentParser } from "./ua-parser-user-agent-parser.js";

describe("UaParserUserAgentParser", () => {
  const parser = new UaParserUserAgentParser();

  it("parses a known desktop browser", () => {
    const info = parser.parse(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    );
    expect(info.deviceType).toBe("DESKTOP");
    expect(info.browser).toBe("Chrome");
    expect(info.browserVersion).toBe("119.0.0.0");
    expect(info.os).toBe("Windows");
    expect(info.osVersion).toBe("10");
  });

  it("parses a known mobile device (iPhone)", () => {
    const info = parser.parse(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    );
    expect(info.deviceType).toBe("MOBILE");
    expect(info.os).toBe("iOS");
  });

  it("parses a known mobile device (Android)", () => {
    const info = parser.parse(
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
    );
    expect(info.deviceType).toBe("MOBILE");
    expect(info.os).toBe("Android");
  });

  it("parses a known tablet (iPad)", () => {
    const info = parser.parse(
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    );
    expect(info.deviceType).toBe("TABLET");
  });

  it("returns UNKNOWN for a malformed/nonsensical user agent", () => {
    const info = parser.parse("not a real user agent at all !!");
    expect(info.deviceType).toBe("UNKNOWN");
    expect(info.browser).toBeNull();
    expect(info.os).toBeNull();
  });

  it("returns UNKNOWN for an empty string", () => {
    const info = parser.parse("");
    expect(info.deviceType).toBe("UNKNOWN");
  });

  it("returns UNKNOWN for undefined/missing input, without throwing", () => {
    expect(() => parser.parse(undefined)).not.toThrow();
    expect(parser.parse(undefined).deviceType).toBe("UNKNOWN");
    expect(() => parser.parse(null)).not.toThrow();
  });

  it("never touches ua-parser-js's own bot-detection module (bot classification stays owned by BotDetectionEngine)", () => {
    // A well-known crawler UA should still be parsed for its browser/OS
    // fields like any other UA — this parser has no concept of "bot".
    const info = parser.parse("Googlebot/2.1 (+http://www.google.com/bot.html)");
    expect(info).not.toHaveProperty("classification");
    expect(info).not.toHaveProperty("isBot");
  });
});
