import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ApiError,
  TrackingResolutionError,
  TransparentRedirectValidationError,
  extractCountrySignal,
  extractReferrerHost,
  hashIp,
  isTrustedEdgeRequest,
  resolveRoutingDecision,
  validateTransparentRedirectUrl,
  type BotDetectionEngine,
  type BotDetectionHeaderSignals,
  type GeoLocationProvider,
  type RoutingContext,
  type TrackingResolver,
  type UserAgentParser,
} from "@adstrackio/shared";
import { classifyWithSafeFallback } from "../bot-detection/classify-with-fallback.js";
import { generateClickId } from "./click-id.js";
import { recordClick } from "./tracker.service.js";

export interface TrackerRouteOptions {
  resolver: TrackingResolver;
  botDetectionEngine: BotDetectionEngine;
  userAgentParser: UserAgentParser;
  geoLocationProvider: GeoLocationProvider;
  ipHashSalt: string;
  /** See packages/shared/src/routing-signals.ts's module doc — unset
   * means COUNTRY routing-rule conditions never match for any request. */
  trustedEdgeSecret: string | undefined;
}

/**
 * Strips a port suffix from the Host header (e.g. "track.example.com:8443"
 * in a non-standard-port deployment) and lowercases it — a registered
 * TrackingDomain hostname never itself contains a port (Phase 2 rejects
 * that at creation), so this is normalizing the *request*, not the stored
 * value, to the same shape.
 *
 * A bracketed IPv6 literal (RFC 3986/7230: "[::1]" or "[::1]:8443") has to
 * be handled specially — naively splitting on the first ":" would cut a
 * bare IPv6 address into garbage (e.g. "[::1]" -> "["). This still can't
 * change which domain a request resolves to: `normalizeTrackingHostname`
 * (packages/shared/src/hostname.ts) rejects IP literals outright at
 * TrackingDomain creation, so no registered domain is ever an IP address
 * and an IPv6 Host header can never match one either way — this is
 * correctness/hygiene (a sane, predictable lookup key and sane logs), not
 * a fix for a reachable routing bug.
 */
export function normalizeRequestHostname(hostname: string): string {
  const trimmed = hostname.trim();

  if (trimmed.startsWith("[")) {
    const closingBracket = trimmed.indexOf("]");
    if (closingBracket !== -1) {
      // Keep "[...]" intact; only a trailing ":<port>" after the bracket
      // (if any) is stripped.
      return trimmed.slice(0, closingBracket + 1).toLowerCase();
    }
    // Malformed (opening bracket, no closing one) — fall through to the
    // plain-hostname path below rather than throwing; it still can't
    // match a real TrackingDomain, so this safely 404s downstream.
  }

  return trimmed.split(":")[0]!.toLowerCase();
}

/** Fastify/Node header values are `string | string[] | undefined`; these
 * headers are never legitimately repeated, so the first value (if any) is
 * used and anything else normalizes to `undefined` — never an array or
 * empty string treated as "present." */
function headerString(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.trim() ? raw : undefined;
}

/** Extracts only the small, explicit set of headers the detection engine
 * is allowed to see (packages/shared/src/bot-detection.ts) — never the
 * full raw header set. */
function extractDetectionHeaderSignals(request: FastifyRequest): BotDetectionHeaderSignals {
  return {
    accept: headerString(request.headers.accept),
    acceptLanguage: headerString(request.headers["accept-language"]),
    secFetchMode: headerString(request.headers["sec-fetch-mode"]),
    secFetchSite: headerString(request.headers["sec-fetch-site"]),
    secFetchDest: headerString(request.headers["sec-fetch-dest"]),
  };
}

function mapResolutionError(error: TrackingResolutionError): ApiError {
  if (error.reason === "link_inactive") {
    // 410 Gone: this slug existed and was deliberately retired, distinct
    // from "never existed" (404) — see docs/architecture/security.md.
    return new ApiError("NOT_FOUND", 410, "This tracking link is no longer active");
  }
  // Every other failure (unknown/unverified/inactive domain, unknown link)
  // gets a uniform 404. Distinguishing "domain exists but isn't verified"
  // from "domain doesn't exist" to an anonymous caller would be an
  // unnecessary information leak about which hostnames are registered.
  return ApiError.notFound("Not found");
}

export async function registerTrackerRoutes(
  fastify: FastifyInstance,
  options: TrackerRouteOptions,
) {
  fastify.get("/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const hostname = normalizeRequestHostname(request.hostname);

    request.log.info({ hostname, slug }, "tracker request");

    const query = request.query as Record<string, unknown>;
    const rawRedirectionUrl = query.redirection_url;

    if (typeof rawRedirectionUrl !== "string") {
      request.log.warn({ hostname, slug }, "invalid transparent destination");
      throw ApiError.validation("redirection_url query parameter is required");
    }

    let redirectTarget: string;
    try {
      redirectTarget = validateTransparentRedirectUrl(rawRedirectionUrl);
    } catch (error) {
      if (error instanceof TransparentRedirectValidationError) {
        request.log.warn(
          { hostname, slug, reason: error.message },
          "invalid transparent destination",
        );
        throw ApiError.validation(error.message);
      }
      throw error;
    }

    let resolution;
    try {
      resolution = await options.resolver.resolve({ hostname, slug });
    } catch (error) {
      if (error instanceof TrackingResolutionError) {
        request.log.warn(
          { hostname, slug, reason: error.reason },
          error.reason.startsWith("domain") ? "domain resolution failure" : "link resolution failure",
        );
        throw mapResolutionError(error);
      }
      throw error;
    }

    const clickId = generateClickId();
    const userAgentHeader = request.headers["user-agent"];
    const userAgent = typeof userAgentHeader === "string" ? userAgentHeader : undefined;
    const refererHeader = request.headers.referer;
    const referrer = typeof refererHeader === "string" ? refererHeader : undefined;
    const ipHash = hashIp(request.ip, options.ipHashSalt);

    // Bot classification is entirely server-computed from server-observed
    // request data (User-Agent + a small explicit set of other headers,
    // via the injected BotDetectionEngine) — there is no request field
    // that can assert its own bot/human status, override the score, or
    // supply its own reason codes. classifyWithSafeFallback guarantees a
    // classification is always produced, even if the engine throws,
    // rejects, or hangs (see its doc comment) — detection failure must
    // never crash or stall the redirect.
    const classification = await classifyWithSafeFallback(options.botDetectionEngine, {
      clickId,
      userAgent,
      ipHash,
      headers: extractDetectionHeaderSignals(request),
    });

    // Routing signals for rule conditions (Phase 8) — every one of these
    // is a synchronous, local computation (pure UA string matching, a
    // known-header read, a URL parse); none of them add latency to the
    // redirect. UA is parsed here (again, separately from the copy
    // recordClick's safeParseUserAgent computes below for the Click row)
    // deliberately — routing must be decided before the click is even
    // written, and threading a shared DeviceInfo through RecordClickInput
    // would couple the two for no real benefit: parsing a UA string twice
    // is cheap, pure, and keeps each module self-contained.
    // UserAgentParser.parse is documented as pure/synchronous but callers
    // are expected to defend against a parser bug regardless (see
    // packages/shared/src/user-agent.ts) — mirrors tracker.service.ts's
    // safeParseUserAgent: a throw here degrades to "unknown" rather than
    // ever failing the redirect.
    let deviceInfo: { deviceType: RoutingContext["deviceType"]; browser: string | null; os: string | null };
    try {
      deviceInfo = options.userAgentParser.parse(userAgent);
    } catch {
      deviceInfo = { deviceType: "UNKNOWN", browser: null, os: null };
    }
    const requestHeaders = request.headers as Record<string, string | string[] | undefined>;

    // Defense-in-depth observability, not enforcement: extractCountrySignal
    // below already refuses to read a geo header at all unless
    // isTrustedEdgeRequest confirms the trusted-edge secret is present and
    // correct (see packages/shared/src/routing-signals.ts) — this log line
    // exists purely so an operator can see a request that carried a raw
    // geo header without ever passing the trust check, which is exactly
    // what a client attempting to spoof COUNTRY routing would look like.
    if (!isTrustedEdgeRequest(requestHeaders, options.trustedEdgeSecret)) {
      const suspiciousGeoHeader = ["cf-ipcountry", "x-vercel-ip-country", "cloudfront-viewer-country"].find(
        (name) => requestHeaders[name] !== undefined,
      );
      if (suspiciousGeoHeader) {
        request.log.warn(
          { header: suspiciousGeoHeader },
          "geo header present on an untrusted request — ignored, possible COUNTRY spoofing attempt",
        );
      }
    }

    const routingContext: RoutingContext = {
      botClassification: classification.classification,
      country: extractCountrySignal(requestHeaders, options.trustedEdgeSecret),
      deviceType: classification.classification === "BOT" ? "BOT" : deviceInfo.deviceType,
      browser: deviceInfo.browser,
      os: deviceInfo.os,
      referrerHost: extractReferrerHost(referrer),
    };

    // The routing decision is resolved purely from the classification, the
    // campaign's routing rules, and its default bot-traffic policy
    // (packages/shared's resolveRoutingDecision) — never from any
    // request-supplied value. See resolveRoutingDecision's doc comment for
    // the full BOT policy -> routing rules -> campaign default precedence
    // (Phase 8: Rules & Routing Engine). BOT always maps to SAFE_PAGE and
    // is never subject to a routing rule; HUMAN/SUSPICIOUS/UNKNOWN are.
    const routingDecision = resolveRoutingDecision({
      classification: classification.classification,
      botTrafficPolicy: resolution.botTrafficPolicy,
      rules: resolution.routingRules,
      context: routingContext,
    });
    const routingAction = routingDecision.action;

    request.log.info(
      {
        clickId,
        trackingLinkId: resolution.trackingLinkId,
        classification: classification.classification,
        reasonCodes: classification.reasonCodes,
        routingAction,
        routingSource: routingDecision.source,
        matchedRuleId: routingDecision.matchedRuleId,
      },
      "bot classification",
    );

    await recordClick(
      fastify.prisma,
      {
        id: clickId,
        organizationId: resolution.organizationId,
        campaignId: resolution.campaignId,
        trackingLinkId: resolution.trackingLinkId,
        userAgent,
        referrer,
        ipHash,
        ip: request.ip,
        classification,
        affiliatePartnerId: resolution.affiliatePartnerId,
      },
      {
        userAgentParser: options.userAgentParser,
        geoLocationProvider: options.geoLocationProvider,
      },
    );

    switch (routingAction) {
      case "SAFE_PAGE": {
        if (!resolution.safePageUrl) {
          request.log.info({ clickId, routedTo: "controlled-404" }, "redirect decision");
          throw ApiError.notFound("Not found");
        }
        request.log.info({ clickId, routedTo: "safe-page" }, "redirect decision");
        reply.redirect(resolution.safePageUrl, 302);
        return;
      }
      case "BLOCK": {
        // Same controlled, no-hidden-destination response as "SAFE_PAGE
        // configured but unset" — BLOCK never guesses a destination and
        // never falls back to the transparent one.
        request.log.info({ clickId, routedTo: "blocked" }, "redirect decision");
        throw ApiError.notFound("Not found");
      }
      case "TARGET": {
        request.log.info({ clickId, routedTo: "transparent-destination" }, "redirect decision");
        reply.redirect(redirectTarget, 302);
        return;
      }
    }
  });
}
