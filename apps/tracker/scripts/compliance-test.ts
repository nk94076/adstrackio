#!/usr/bin/env -S node --import tsx
/**
 * Google Transparent Click Tracker compliance test tool (Phase 12) — see
 * docs/compliance/google-certification-checklist.md and
 * docs/compliance/google-transparent-click-tracker.md.
 *
 * Deliberately small and deterministic, not a framework: a flat list of
 * named checks, each either PASS, FAIL, or SKIP, printed as a summary
 * table with a non-zero exit code on any FAIL.
 *
 * Two modes:
 *
 * LOCAL (default): builds the real apps/tracker Fastify app in-process
 * (the exact same buildTrackerApp production uses) against this
 * environment's configured DATABASE_URL, creates its own throwaway
 * fixtures via Prisma (an Organization/TrackingDomain/Campaign/
 * TrackingLink chain — the same fixture helper apps/tracker's own test
 * suite uses), and exercises the full transparency matrix end to end,
 * including bot routing and domain-state checks that need a known,
 * controlled fixture to test at all.
 *
 * REMOTE (opt-in via `--remote`, requires TRACKER_URL): makes real HTTP
 * requests against a deployed tracker. By default, only checks that
 * don't require knowledge of a real, pre-existing tracking slug are run
 * (missing parameter, dangerous protocol, unknown slug, basic
 * connectivity). Two further, optional environment variables extend
 * this to a real tracking link the operator controls:
 *
 *   - COMPLIANCE_TEST_HOSTNAME, COMPLIANCE_TEST_SLUG: when BOTH are
 *     set, the tool sends a real request to TRACKER_URL for
 *     `/<COMPLIANCE_TEST_SLUG>?redirection_url=...`, with an explicit
 *     `Host: <COMPLIANCE_TEST_HOSTNAME>` header (independent of
 *     whatever host TRACKER_URL itself resolves to — the same
 *     virtual-hosting technique a CDN or load balancer uses), and
 *     verifies the immediate HTTP response is a 3xx redirect whose
 *     Location header is exactly the redirection_url this tool sent.
 *     This requires Node's core `http`/`https` modules rather than
 *     `fetch`: the Fetch spec treats `Host` as a forbidden header and
 *     silently ignores an attempt to set it.
 *
 *   - COMPLIANCE_TEST_SAFE_PAGE_URL: when set alongside the two above,
 *     additionally verifies that a bot-classified request to the same
 *     tracking link redirects to exactly this URL. This check only
 *     runs when the expected Safe Page URL is supplied explicitly —
 *     the tool never guesses at what a real deployment's Safe Page is
 *     configured to, so without this variable the check stays SKIPPED.
 *
 * Anything that still needs a real fixture this tool cannot safely
 * construct against a live deployment (inactive/unverified-domain
 * behavior, which would require deactivating real production data) is
 * always reported as SKIPPED with the reason, never faked or assumed.
 *
 * This tool only ever issues GET requests against the tracker's own
 * redirect endpoint — it never calls any admin/mutating API, so it
 * cannot itself change production data or domain state.
 *
 * Phase 13 (Production Launch & Certification Evidence): the
 * "configured real link" exact-redirect check prints the raw request/
 * response (method, path, Host header, HTTP status, Location header)
 * to stdout unconditionally — this is the literal evidence a real
 * certification submission needs, and is designed to be run and pasted
 * directly into docs/compliance/google-certification-evidence.md. See
 * that document and docs/compliance/production-tracker-verification.md.
 *
 * Usage:
 *   pnpm compliance:test                 # local, in-process
 *   pnpm compliance:test -- --remote     # remote, against $TRACKER_URL
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { getEnv } from "@adstrackio/config";
import { prisma } from "@adstrackio/database";
import { buildTrackerApp } from "../src/app.js";
import { createTrackerFixture } from "../test/fixtures.js";

export interface CheckResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail?: string;
}

export interface ComplianceRunner {
  results: CheckResult[];
  check(name: string, fn: () => Promise<void>): Promise<void>;
  skip(name: string, reason: string): void;
}

export function createComplianceRunner(): ComplianceRunner {
  const results: CheckResult[] = [];
  return {
    results,
    async check(name, fn) {
      try {
        await fn();
        results.push({ name, status: "PASS" });
      } catch (error) {
        results.push({
          name,
          status: "FAIL",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
    skip(name, reason) {
      results.push({ name, status: "SKIP", detail: reason });
    },
  };
}

const HUMAN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const BOT_UA = "Googlebot/2.1 (+http://www.google.com/bot.html)";

// The redirection_url this tool supplies in its own test requests. This is
// not, and is never claimed to be, a real operator's advertiser landing
// page — the tool only verifies the tracker returns exactly this value
// unchanged, the same technique LOCAL mode and
// apps/tracker/test/google-transparency-compliance.test.ts already use.
const TEST_REDIRECTION_URL = "https://example.com/landing?utm_source=ads&utm_campaign=x#top";

// ---------------------------------------------------------------------------
// LOCAL mode
// ---------------------------------------------------------------------------

export async function runLocal(runner: ComplianceRunner): Promise<void> {
  console.log("Mode: LOCAL (in-process apps/tracker against the configured DATABASE_URL)\n");

  const env = getEnv();
  const app = await buildTrackerApp({ env, logger: false });

  async function hit(
    hostname: string,
    slug: string,
    query = "",
    headers: Record<string, string> = {},
  ) {
    return app.inject({
      method: "GET",
      url: `/${slug}${query}`,
      headers: { host: hostname, "user-agent": HUMAN_UA, ...headers },
    });
  }

  try {
    const fixture = await createTrackerFixture();
    const target = TEST_REDIRECTION_URL;

    await runner.check("tracker responds to a well-formed request", async () => {
      const res = await hit(
        fixture.hostname,
        fixture.slug,
        `?redirection_url=${encodeURIComponent(target)}`,
      );
      if (res.statusCode === 0) throw new Error("no response received");
    });

    await runner.check(
      "visible redirection_url is the exact immediate redirect target",
      async () => {
        const res = await hit(
          fixture.hostname,
          fixture.slug,
          `?redirection_url=${encodeURIComponent(target)}`,
        );
        if (res.statusCode !== 302) throw new Error(`expected 302, got ${res.statusCode}`);
        if (res.headers.location !== target) {
          throw new Error(`expected Location: ${target}, got: ${res.headers.location}`);
        }
      },
    );

    await runner.check(
      "missing redirection_url is rejected (400), no hidden destination used",
      async () => {
        const res = await hit(fixture.hostname, fixture.slug);
        if (res.statusCode !== 400) throw new Error(`expected 400, got ${res.statusCode}`);
        if (res.headers.location)
          throw new Error(`unexpected Location header: ${res.headers.location}`);
      },
    );

    await runner.check(
      "a dangerous protocol destination (javascript:) is rejected (400)",
      async () => {
        const res = await hit(
          fixture.hostname,
          fixture.slug,
          `?redirection_url=${encodeURIComponent("javascript:alert(1)")}`,
        );
        if (res.statusCode !== 400) throw new Error(`expected 400, got ${res.statusCode}`);
      },
    );

    await runner.check("a malformed redirection_url is rejected (400)", async () => {
      const res = await hit(
        fixture.hostname,
        fixture.slug,
        `?redirection_url=${encodeURIComponent("not a url")}`,
      );
      if (res.statusCode !== 400) throw new Error(`expected 400, got ${res.statusCode}`);
    });

    await runner.check("an unknown tracking slug fails safely (404)", async () => {
      const res = await hit(
        fixture.hostname,
        `unknown-slug-${Date.now()}`,
        `?redirection_url=${encodeURIComponent(target)}`,
      );
      if (res.statusCode !== 404) throw new Error(`expected 404, got ${res.statusCode}`);
    });

    await runner.check("an unverified tracking domain fails safely (404)", async () => {
      const unverified = await createTrackerFixture({ domainVerified: false });
      const res = await hit(
        unverified.hostname,
        unverified.slug,
        `?redirection_url=${encodeURIComponent(target)}`,
      );
      if (res.statusCode !== 404) throw new Error(`expected 404, got ${res.statusCode}`);
    });

    await runner.check("an inactive tracking domain fails safely (404)", async () => {
      const inactive = await createTrackerFixture({ domainActive: false });
      const res = await hit(
        inactive.hostname,
        inactive.slug,
        `?redirection_url=${encodeURIComponent(target)}`,
      );
      if (res.statusCode !== 404) throw new Error(`expected 404, got ${res.statusCode}`);
    });

    await runner.check(
      "BOT traffic routes to the configured Safe Page, never the visible destination",
      async () => {
        const safe = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
        const res = await hit(
          safe.hostname,
          safe.slug,
          `?redirection_url=${encodeURIComponent(target)}`,
          {
            "user-agent": BOT_UA,
          },
        );
        if (res.statusCode !== 302) throw new Error(`expected 302, got ${res.statusCode}`);
        if (res.headers.location !== "https://safe.example.com/") {
          throw new Error(`expected Safe Page redirect, got: ${res.headers.location}`);
        }
      },
    );

    await runner.check(
      "HUMAN traffic reaches exactly the visible destination, never the Safe Page",
      async () => {
        const safe = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
        const res = await hit(
          safe.hostname,
          safe.slug,
          `?redirection_url=${encodeURIComponent(target)}`,
        );
        if (res.headers.location !== target) {
          throw new Error(`expected visible destination, got: ${res.headers.location}`);
        }
      },
    );
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
}

// ---------------------------------------------------------------------------
// REMOTE mode
// ---------------------------------------------------------------------------

interface RawHttpResponse {
  status: number;
  location: string | undefined;
}

/**
 * A minimal raw HTTP GET that (a) never follows redirects — Node's core
 * http/https modules don't auto-follow, unlike `fetch` with
 * redirect:"follow" — and (b) can send an explicit Host header that
 * differs from the host TRACKER_URL's own connection uses, the same
 * virtual-hosting technique a CDN or load balancer relies on. This is
 * only used for the optional COMPLIANCE_TEST_HOSTNAME/
 * COMPLIANCE_TEST_SLUG checks below: the global `fetch` API treats
 * `Host` as a forbidden header and silently overrides it, so it cannot
 * be used to exercise a specific tracking domain against a
 * differently-addressed TRACKER_URL.
 */
function rawGetWithHostHeader(
  baseUrl: string,
  path: string,
  hostHeader: string,
  userAgent: string,
): Promise<RawHttpResponse> {
  const target = new URL(baseUrl);
  const requestFn = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requestFn(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path,
        method: "GET",
        headers: { Host: hostHeader, "User-Agent": userAgent },
        timeout: 10_000,
      },
      (res) => {
        const rawLocation = res.headers.location;
        const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
        resolve({ status: res.statusCode ?? 0, location });
        res.resume();
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

export async function runRemote(
  baseUrl: string,
  runner: ComplianceRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  console.log(`Mode: REMOTE (real HTTP requests against ${baseUrl})\n`);
  console.log(
    "Note: without a known, real tracking slug/domain on this deployment, only " +
      "checks that don't require one can run — see SKIPPED entries below.\n",
  );

  async function fetchNoFollow(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { redirect: "manual" });
  }

  await runner.check("tracker responds", async () => {
    const res = await fetchNoFollow(
      `/__adstrackio_compliance_probe__?redirection_url=https://example.com/x`,
    );
    if (res.status === 0) throw new Error("no response received");
  });

  await runner.check("missing redirection_url is rejected (400)", async () => {
    const res = await fetchNoFollow(`/__adstrackio_compliance_probe__`);
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
  });

  await runner.check(
    "a dangerous protocol destination (javascript:) is rejected (400)",
    async () => {
      const res = await fetchNoFollow(
        `/__adstrackio_compliance_probe__?redirection_url=${encodeURIComponent("javascript:alert(1)")}`,
      );
      if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
    },
  );

  await runner.check("an unknown tracking slug fails safely (404)", async () => {
    const res = await fetchNoFollow(
      `/__definitely_unknown_slug_${Date.now()}__?redirection_url=${encodeURIComponent("https://example.com/x")}`,
    );
    if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`);
  });

  const testHostname = env.COMPLIANCE_TEST_HOSTNAME;
  const testSlug = env.COMPLIANCE_TEST_SLUG;
  const testSafePageUrl = env.COMPLIANCE_TEST_SAFE_PAGE_URL;

  if (testHostname && testSlug) {
    console.log(
      `Configured real tracking link found (COMPLIANCE_TEST_HOSTNAME=${testHostname}, ` +
        `COMPLIANCE_TEST_SLUG=${testSlug}) — running the real Location-header check against it.\n`,
    );

    const path = `/${encodeURIComponent(testSlug)}?redirection_url=${encodeURIComponent(TEST_REDIRECTION_URL)}`;

    await runner.check(
      "visible redirection_url is the exact immediate redirect target (configured real link)",
      async () => {
        const res = await rawGetWithHostHeader(baseUrl, path, testHostname, HUMAN_UA);
        // Printed unconditionally (pass or fail) — this is the literal
        // evidence a certification submission needs: the raw HTTP status
        // and Location header of an immediate, un-followed response. See
        // docs/compliance/google-certification-evidence.md.
        console.log(
          `  Evidence — GET ${path}\n` +
            `             Host: ${testHostname}\n` +
            `             -> HTTP ${res.status}\n` +
            `             -> Location: ${res.location ?? "(none)"}\n`,
        );
        if (res.status < 300 || res.status >= 400) {
          throw new Error(`expected a 3xx redirect, got ${res.status}`);
        }
        if (res.location !== TEST_REDIRECTION_URL) {
          throw new Error(
            `expected Location: ${TEST_REDIRECTION_URL}, got: ${res.location ?? "(none)"}`,
          );
        }
      },
    );

    if (testSafePageUrl) {
      await runner.check(
        "BOT traffic routes to the configured Safe Page (configured real link)",
        async () => {
          const res = await rawGetWithHostHeader(baseUrl, path, testHostname, BOT_UA);
          if (res.status < 300 || res.status >= 400) {
            throw new Error(`expected a 3xx redirect, got ${res.status}`);
          }
          if (res.location !== testSafePageUrl) {
            throw new Error(
              `expected Location: ${testSafePageUrl}, got: ${res.location ?? "(none)"}`,
            );
          }
        },
      );
    } else {
      runner.skip(
        "BOT traffic routes to the configured Safe Page (configured real link)",
        "COMPLIANCE_TEST_HOSTNAME/COMPLIANCE_TEST_SLUG are set but COMPLIANCE_TEST_SAFE_PAGE_URL is not, so the " +
          "expected Safe Page destination isn't known — this tool will not guess at it. Set " +
          "COMPLIANCE_TEST_SAFE_PAGE_URL to the exact Safe Page URL configured on this tracking link's campaign " +
          "to run this check.",
      );
    }
  } else {
    runner.skip(
      "visible redirection_url is the exact immediate redirect target",
      "requires a known, real tracking slug on this deployment — not testable without one. Run in LOCAL mode, " +
        "or set COMPLIANCE_TEST_HOSTNAME and COMPLIANCE_TEST_SLUG to a tracking link you control on this " +
        "deployment (see docs/compliance/google-certification-checklist.md).",
    );
    runner.skip(
      "BOT traffic routes to the configured Safe Page",
      "requires COMPLIANCE_TEST_HOSTNAME, COMPLIANCE_TEST_SLUG, and COMPLIANCE_TEST_SAFE_PAGE_URL — not " +
        "testable without them.",
    );
  }

  runner.skip(
    "inactive/unverified tracking domain fails safely",
    "deliberately not tested against a live deployment — deactivating a real domain to test this would disrupt live traffic.",
  );
}

// ---------------------------------------------------------------------------

export type RunMode =
  { kind: "local" } | { kind: "remote"; baseUrl: string } | { kind: "error"; message: string };

export function resolveRunMode(argv: string[], env: NodeJS.ProcessEnv): RunMode {
  if (!argv.includes("--remote")) return { kind: "local" };
  const trackerUrl = env.TRACKER_URL;
  if (!trackerUrl) {
    return { kind: "error", message: "--remote was passed but TRACKER_URL is not set." };
  }
  return { kind: "remote", baseUrl: trackerUrl.replace(/\/+$/, "") };
}

export function formatResults(results: CheckResult[]): string {
  const width = results.length > 0 ? Math.max(...results.map((r) => r.name.length)) : 0;
  const lines = results.map((result) => {
    const label = result.status.padEnd(4);
    return `  [${label}] ${result.name.padEnd(width)}${result.detail ? `  — ${result.detail}` : ""}`;
  });
  const failed = results.filter((r) => r.status === "FAIL").length;
  const passed = results.filter((r) => r.status === "PASS").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  return `${lines.join("\n")}\n\n${passed} passed, ${failed} failed, ${skipped} skipped.\n`;
}

async function main(): Promise<void> {
  const mode = resolveRunMode(process.argv, process.env);
  if (mode.kind === "error") {
    console.error(`${mode.message} Aborting.`);
    process.exit(1);
  }

  const runner = createComplianceRunner();
  if (mode.kind === "remote") {
    await runRemote(mode.baseUrl, runner);
  } else {
    await runLocal(runner);
  }

  console.log("\nResults:\n");
  console.log(formatResults(runner.results));

  if (runner.results.some((r) => r.status === "FAIL")) {
    process.exit(1);
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((error) => {
    console.error("Compliance test tool crashed:", error);
    process.exit(1);
  });
}
