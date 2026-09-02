import { UAParser } from "ua-parser-js";
import {
  UNKNOWN_DEVICE_INFO,
  type AnalyticsDeviceType,
  type DeviceInfo,
  type UserAgentParser,
} from "@adstrackio/shared";

/**
 * Real (Phase 4) implementation of UserAgentParser, backed by ua-parser-js
 * — a mature, widely-used, MIT-licensed parsing library (no network calls,
 * pure string matching). Deliberately imports only the library's main
 * export: ua-parser-js also ships a `ua-parser-js/bot-detection` module,
 * which this code never touches — bot/human classification stays owned
 * exclusively by BotDetectionEngine (see
 * apps/tracker/src/modules/bot-detection/), never duplicated here.
 */
export class UaParserUserAgentParser implements UserAgentParser {
  parse(userAgent: string | null | undefined): DeviceInfo {
    if (!userAgent || !userAgent.trim()) {
      return UNKNOWN_DEVICE_INFO;
    }

    const result = new UAParser(userAgent).getResult();

    const browser = result.browser.name ?? null;
    const browserVersion = result.browser.version ?? null;
    const os = result.os.name ?? null;
    const osVersion = result.os.version ?? null;

    // ua-parser-js leaves every field empty for input it can't parse at
    // all — including device.type, which is ALSO left unset for a normal
    // desktop browser. Without this check, "couldn't parse anything" and
    // "definitely a desktop" would be indistinguishable.
    if (!browser && !os) {
      return UNKNOWN_DEVICE_INFO;
    }

    return { deviceType: mapDeviceType(result.device.type), browser, browserVersion, os, osVersion };
  }
}

function mapDeviceType(uaParserDeviceType: string | undefined): AnalyticsDeviceType {
  switch (uaParserDeviceType) {
    case undefined:
      // ua-parser-js leaves `device.type` unset for a plain desktop
      // browser UA — this is the common case, not a parsing failure.
      return "DESKTOP";
    case "mobile":
      return "MOBILE";
    case "tablet":
      return "TABLET";
    case "console":
    case "smarttv":
    case "wearable":
    case "xr":
    case "embedded":
      return "OTHER";
    default:
      return "UNKNOWN";
  }
}
