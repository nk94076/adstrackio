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
 * requests against a deployed tracker. Only checks that don't require
 * knowledge of a real, pre-existing tracking slug are run (missing
 * parameter, dangerous protocol, unknown slug, basic connectivity) —
 * anything that needs a specific real slug/domain to observe (exact
 * redirection_url pass-through, bot routing, inactive-domain behavior)
 * is reported as SKIPPED with the reason, never faked or assumed.
 *
 * Usage:
 *   pnpm compliance:test                 # local, in-process
 *   pnpm compliance:test -- --remote     # remote, against $TRACKER_URL
 */
import { getEnv } from "@adstrackio/config";
import { prisma } from "@adstrackio/database";
import { buildTrackerApp } from "../src/app.js";
import { createTrackerFixture } from "../test/fixtures.js";

interface CheckResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail?: string;
}

const results: CheckResult[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, status: "PASS" });
  } catch (error) {
    results.push({ name, status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
  }
}

function skip(name: string, reason: string): void {
  results.push({ name, status: "SKIP", detail: reason });
}

const HUMAN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const BOT_UA = "Googlebot/2.1 (+http://www.google.com/bot.html)";

// ---------------------------------------------------------------------------
// LOCAL mode
// ---------------------------------------------------------------------------

async function runLocal(): Promise<void> {
  console.log("Mode: LOCAL (in-process apps/tracker against the configured DATABASE_URL)\n");

  const env = getEnv();
  const app = await buildTrackerApp({ env, logger: false });

  async function hit(hostname: string, slug: string, query = "", headers: Record<string, string> = {}) {
    return app.inject({
      method: "GET",
      url: `/${slug}${query}`,
      headers: { host: hostname, "user-agent": HUMAN_UA, ...headers },
    });
  }

  try {
    const fixture = await createTrackerFixture();
    const target = "https://example.com/landing?utm_source=ads&utm_campaign=x#top";

    await check("tracker responds to a well-formed request", async () => {
      const res = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`);
      if (res.statusCode === 0) throw new Error("no response received");
    });

    await check("visible redirection_url is the exact immediate redirect target", async () => {
      const res = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`);
      if (res.statusCode !== 302) throw new Error(`expected 302, got ${res.statusCode}`);
      if (res.headers.location !== target) {
        throw new Error(`expected Location: ${target}, got: ${res.headers.location}`);
      }
    });

    await check("missing redirection_url is rejected (400), no hidden destination used", async () => {
      const res = await hit(fixture.hostname, fixture.slug);
      if (res.statusCode !== 400) throw new Error(`expected 400, got ${res.statusCode}`);
      if (res.headers.location) throw new Error(`unexpected Location header: ${res.headers.location}`);
    });

    await check("a dangerous protocol destination (javascript:) is rejected (400)", async () => {
      const res = await hit(
        fixture.hostname,
        fixture.slug,
        `?redirection_url=${encodeURIComponent("javascript:alert(1)")}`,
      );
      if (res.statusCode !== 400) throw new Error(`expected 400, got ${res.statusCode}`);
    });

    await check("a malformed redirection_url is rejected (400)", async () => {
      const res = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent("not a url")}`);
      if (res.statusCode !== 400) throw new Error(`expected 400, got ${res.statusCode}`);
    });

    await check("an unknown tracking slug fails safely (404)", async () => {
      const res = await hit(
        fixture.hostname,
        `unknown-slug-${Date.now()}`,
        `?redirection_url=${encodeURIComponent(target)}`,
      );
      if (res.statusCode !== 404) throw new Error(`expected 404, got ${res.statusCode}`);
    });

    await check("an unverified tracking domain fails safely (404)", async () => {
      const unverified = await createTrackerFixture({ domainVerified: false });
      const res = await hit(unverified.hostname, unverified.slug, `?redirection_url=${encodeURIComponent(target)}`);
      if (res.statusCode !== 404) throw new Error(`expected 404, got ${res.statusCode}`);
    });

    await check("an inactive tracking domain fails safely (404)", async () => {
      const inactive = await createTrackerFixture({ domainActive: false });
      const res = await hit(inactive.hostname, inactive.slug, `?redirection_url=${encodeURIComponent(target)}`);
      if (res.statusCode !== 404) throw new Error(`expected 404, got ${res.statusCode}`);
    });

    await check("BOT traffic routes to the configured Safe Page, never the visible destination", async () => {
      const safe = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
      const res = await hit(safe.hostname, safe.slug, `?redirection_url=${encodeURIComponent(target)}`, {
        "user-agent": BOT_UA,
      });
      if (res.statusCode !== 302) throw new Error(`expected 302, got ${res.statusCode}`);
      if (res.headers.location !== "https://safe.example.com/") {
        throw new Error(`expected Safe Page redirect, got: ${res.headers.location}`);
      }
    });

    await check("HUMAN traffic reaches exactly the visible destination, never the Safe Page", async () => {
      const safe = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
      const res = await hit(safe.hostname, safe.slug, `?redirection_url=${encodeURIComponent(target)}`);
      if (res.headers.location !== target) {
        throw new Error(`expected visible destination, got: ${res.headers.location}`);
      }
    });
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
}

// ---------------------------------------------------------------------------
// REMOTE mode
// ---------------------------------------------------------------------------

async function runRemote(baseUrl: string): Promise<void> {
  console.log(`Mode: REMOTE (real HTTP requests against ${baseUrl})\n`);
  console.log(
    "Note: without a known, real tracking slug/domain on this deployment, only " +
      "checks that don't require one can run — see SKIPPED entries below.\n",
  );

  async function fetchNoFollow(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { redirect: "manual" });
  }

  await check("tracker responds", async () => {
    const res = await fetchNoFollow(`/__adstrackio_compliance_probe__?redirection_url=https://example.com/x`);
    if (res.status === 0) throw new Error("no response received");
  });

  await check("missing redirection_url is rejected (400)", async () => {
    const res = await fetchNoFollow(`/__adstrackio_compliance_probe__`);
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
  });

  await check("a dangerous protocol destination (javascript:) is rejected (400)", async () => {
    const res = await fetchNoFollow(
      `/__adstrackio_compliance_probe__?redirection_url=${encodeURIComponent("javascript:alert(1)")}`,
    );
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
  });

  await check("an unknown tracking slug fails safely (404)", async () => {
    const res = await fetchNoFollow(
      `/__definitely_unknown_slug_${Date.now()}__?redirection_url=${encodeURIComponent("https://example.com/x")}`,
    );
    if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`);
  });

  skip(
    "visible redirection_url is the exact immediate redirect target",
    "requires a known, real tracking slug on this deployment — not testable without one. Run in LOCAL mode, or configure COMPLIANCE_TEST_HOSTNAME/COMPLIANCE_TEST_SLUG for a slug you control (see docs/compliance/google-certification-checklist.md).",
  );
  skip(
    "BOT traffic routes to the configured Safe Page",
    "requires a known, real tracking slug with a configured Safe Page — not testable without one.",
  );
  skip(
    "inactive/unverified tracking domain fails safely",
    "deliberately not tested against a live deployment — deactivating a real domain to test this would disrupt live traffic.",
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const remote = process.argv.includes("--remote");
  const trackerUrl = process.env.TRACKER_URL;

  if (remote) {
    if (!trackerUrl) {
      console.error("--remote was passed but TRACKER_URL is not set. Aborting.");
      process.exit(1);
    }
    await runRemote(trackerUrl.replace(/\/+$/, ""));
  } else {
    await runLocal();
  }

  console.log("\nResults:\n");
  const width = Math.max(...results.map((r) => r.name.length));
  for (const result of results) {
    const label = result.status.padEnd(4);
    console.log(`  [${label}] ${result.name.padEnd(width)}${result.detail ? `  — ${result.detail}` : ""}`);
  }

  const failed = results.filter((r) => r.status === "FAIL").length;
  const passed = results.filter((r) => r.status === "PASS").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Compliance test tool crashed:", error);
  process.exit(1);
});
