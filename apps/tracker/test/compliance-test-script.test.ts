import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getEnv } from "@adstrackio/config";
import { buildTrackerApp } from "../src/app.js";
import {
  createComplianceRunner,
  formatResults,
  resolveRunMode,
  runRemote,
} from "../scripts/compliance-test.js";
import { resetDatabase } from "./db-reset.js";
import { createTrackerFixture } from "./fixtures.js";

/**
 * Tests apps/tracker/scripts/compliance-test.ts's REMOTE mode directly.
 * The compliance CLI tool is itself certification evidence (see
 * docs/compliance/google-certification-checklist.md), so its behavior
 * needs direct coverage, not just the tracker route it exercises.
 *
 * Runs the real Fastify app on a real, listening TCP port (never
 * app.inject()) so the Host-header-override technique REMOTE mode uses
 * for COMPLIANCE_TEST_HOSTNAME/COMPLIANCE_TEST_SLUG is proven against an
 * actual HTTP server — the same reason the tool itself avoids `fetch`
 * for this check (the Fetch spec forbids setting a custom Host header).
 */

const REDIRECT_CHECK_NAME = "visible redirection_url is the exact immediate redirect target";
const CONFIGURED_REDIRECT_CHECK_NAME = `${REDIRECT_CHECK_NAME} (configured real link)`;
const SAFE_PAGE_CHECK_NAME = "BOT traffic routes to the configured Safe Page";
const CONFIGURED_SAFE_PAGE_CHECK_NAME = `${SAFE_PAGE_CHECK_NAME} (configured real link)`;

let app: FastifyInstance;
let baseUrl: string;

beforeEach(async () => {
  if (!app) {
    app = await buildTrackerApp({ env: getEnv(), logger: false });
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  }
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
});

describe("compliance-test.ts REMOTE mode", () => {
  it("with COMPLIANCE_TEST_HOSTNAME/COMPLIANCE_TEST_SLUG/COMPLIANCE_TEST_SAFE_PAGE_URL configured, verifies the real Location header of a real tracking link", async () => {
    const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
    const runner = createComplianceRunner();

    await runRemote(baseUrl, runner, {
      COMPLIANCE_TEST_HOSTNAME: fixture.hostname,
      COMPLIANCE_TEST_SLUG: fixture.slug,
      COMPLIANCE_TEST_SAFE_PAGE_URL: "https://safe.example.com/",
    });

    expect(runner.results.find((r) => r.name === CONFIGURED_REDIRECT_CHECK_NAME)?.status).toBe("PASS");
    expect(runner.results.find((r) => r.name === CONFIGURED_SAFE_PAGE_CHECK_NAME)?.status).toBe("PASS");

    // The generic, fixture-independent checks still run alongside it.
    expect(runner.results.find((r) => r.name === "tracker responds")?.status).toBe("PASS");
    expect(
      runner.results.find((r) => r.name === "missing redirection_url is rejected (400)")?.status,
    ).toBe("PASS");
  });

  it("with only COMPLIANCE_TEST_HOSTNAME/COMPLIANCE_TEST_SLUG set, SKIPs the Safe Page check without guessing at a destination", async () => {
    const fixture = await createTrackerFixture();
    const runner = createComplianceRunner();

    await runRemote(baseUrl, runner, {
      COMPLIANCE_TEST_HOSTNAME: fixture.hostname,
      COMPLIANCE_TEST_SLUG: fixture.slug,
    });

    expect(runner.results.find((r) => r.name === CONFIGURED_REDIRECT_CHECK_NAME)?.status).toBe("PASS");

    const safePageResult = runner.results.find((r) => r.name === CONFIGURED_SAFE_PAGE_CHECK_NAME);
    expect(safePageResult?.status).toBe("SKIP");
    expect(safePageResult?.detail).toMatch(/COMPLIANCE_TEST_SAFE_PAGE_URL/);
  });

  it("without COMPLIANCE_TEST_HOSTNAME/COMPLIANCE_TEST_SLUG, SKIPs the fixture-dependent checks and never fabricates a PASS", async () => {
    const runner = createComplianceRunner();

    await runRemote(baseUrl, runner, {});

    expect(runner.results.find((r) => r.name === REDIRECT_CHECK_NAME)?.status).toBe("SKIP");
    expect(runner.results.find((r) => r.name === SAFE_PAGE_CHECK_NAME)?.status).toBe("SKIP");
    expect(runner.results.some((r) => r.name.includes("(configured real link)"))).toBe(false);

    // Generic connectivity/validation checks still run without any fixture.
    expect(runner.results.find((r) => r.name === "tracker responds")?.status).toBe("PASS");
    expect(
      runner.results.find((r) => r.name === "missing redirection_url is rejected (400)")?.status,
    ).toBe("PASS");
    expect(
      runner.results.find((r) => r.name === "an unknown tracking slug fails safely (404)")?.status,
    ).toBe("PASS");
  });
});

describe("compliance-test.ts resolveRunMode", () => {
  it("defaults to LOCAL when --remote is not passed", () => {
    expect(resolveRunMode([], {})).toEqual({ kind: "local" });
  });

  it("fails safely when --remote is passed but TRACKER_URL is not set", () => {
    const mode = resolveRunMode(["--remote"], {});
    expect(mode.kind).toBe("error");
    if (mode.kind === "error") {
      expect(mode.message).toContain("TRACKER_URL");
    }
  });

  it("resolves REMOTE with the trailing slash stripped from TRACKER_URL", () => {
    const mode = resolveRunMode(["--remote"], { TRACKER_URL: "https://track.example.com/" });
    expect(mode).toEqual({ kind: "remote", baseUrl: "https://track.example.com" });
  });
});

describe("compliance-test.ts formatResults", () => {
  it("summarizes counts without fabricating a pass for a failed check", () => {
    const runner = createComplianceRunner();
    runner.results.push({ name: "a", status: "PASS" });
    runner.results.push({ name: "b", status: "FAIL", detail: "boom" });
    runner.results.push({ name: "c", status: "SKIP", detail: "not applicable" });
    const summary = formatResults(runner.results);
    expect(summary).toContain("1 passed, 1 failed, 1 skipped.");
    expect(summary).toContain("boom");
  });
});
