#!/usr/bin/env node
//
// Verifies that production Docker packaging (apps/api/Dockerfile,
// apps/tracker/Dockerfile) actually ships a working Prisma query engine
// for the real production runtime (node:20-slim, Debian glibc, OpenSSL 3)
// — not just that `pnpm build`/`pnpm typecheck` pass, which say nothing
// about what `pnpm deploy` puts in the final image or which engine file
// the running container picks at startup. It also fails the build if the
// deployed artifact contains a legacy OpenSSL-1.1 (bare "linux-musl")
// engine, which would crash `PrismaClientInitializationError: Error
// loading shared library libssl.so.1.1` regardless of which engine gets
// picked at runtime.
//
// Prerequisite: `pnpm db:generate` must already have been run (this
// script does not do it itself — same as the Dockerfiles, which run it
// once in the shared `build` stage before either app's `pnpm deploy`).
//
// Usage:
//   node scripts/verify-production-packaging.mjs
//
// Exits 0 if every check passes, 1 (with the specific failures printed)
// otherwise. Safe to run in CI before a production release; not part of
// the fast `pnpm test` suite because it shells out to a real `pnpm
// deploy` per app (a filesystem-heavy operation, not appropriate for a
// hermetic unit-test run).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// The engine actually needed by the real VPS: node:20-slim (Debian,
// glibc) on x86_64. See packages/database/prisma/schema.prisma's
// `binaryTargets` comment and apps/{api,tracker}/Dockerfile's
// PRISMA_QUERY_ENGINE_LIBRARY and "why node:20-slim" comments for the
// full "why" — this must never regress back to a musl engine, and
// especially never to the legacy bare "linux-musl" (OpenSSL 1.1)
// engine, which crashes production with `Error loading shared library
// libssl.so.1.1`.
const REQUIRED_ENGINE = "libquery_engine-debian-openssl-3.0.x.so.node";

// Any engine filename that would load OpenSSL 1.1 instead of OpenSSL 3.
// Prisma only ever produces one such engine: the bare, suffix-less
// "linux-musl" target (as opposed to "linux-musl-openssl-3.0.x" or
// "debian-openssl-3.0.x"). This must NEVER be present in a deployed
// production artifact, regardless of which engine PRISMA_QUERY_ENGINE_LIBRARY
// pins — a stray copy would mean `binaryTargets` regressed to include it.
const FORBIDDEN_OPENSSL_1_1_ENGINE = "libquery_engine-linux-musl.so.node";

const APPS = [
  { name: "@adstrackio/api", dockerfile: "apps/api/Dockerfile" },
  { name: "@adstrackio/tracker", dockerfile: "apps/tracker/Dockerfile" },
];

let failed = false;

function pass(message) {
  console.log(`  ✓ ${message}`);
}

function fail(message) {
  console.error(`  ✗ ${message}`);
  failed = true;
}

for (const app of APPS) {
  console.log(`\n${app.name}:`);
  const deployDir = mkdtempSync(join(tmpdir(), "adstrackio-deploy-verify-"));
  try {
    execFileSync("pnpm", ["--filter", app.name, "deploy", "--prod", "--legacy", deployDir], {
      cwd: repoRoot,
      stdio: "pipe",
      env: { ...process.env, CI: "true" },
    });

    const clientDir = join(deployDir, "node_modules/@adstrackio/database/generated/client");
    const enginePath = join(clientDir, REQUIRED_ENGINE);
    if (existsSync(enginePath)) {
      pass(`deployed Prisma client contains ${REQUIRED_ENGINE}`);
    } else {
      fail(
        `deployed Prisma client is missing ${REQUIRED_ENGINE} — production would crash on ` +
          `node:20-slim with a Prisma query engine error`,
      );
    }

    const forbiddenEnginePath = join(clientDir, FORBIDDEN_OPENSSL_1_1_ENGINE);
    if (existsSync(forbiddenEnginePath)) {
      fail(
        `deployed Prisma client contains ${FORBIDDEN_OPENSSL_1_1_ENGINE} — this engine links ` +
          `against OpenSSL 1.1 (not present on production), which crashes with ` +
          `PrismaClientInitializationError: Error loading shared library libssl.so.1.1`,
      );
    } else {
      pass(`deployed Prisma client does not contain the legacy OpenSSL-1.1 engine`);
    }

    // Belt-and-suspenders: scan every generated engine file actually
    // shipped, not just the two filenames checked above, in case a
    // future binaryTargets change adds an engine neither constant
    // anticipates.
    const shippedEngines = existsSync(clientDir)
      ? readdirSync(clientDir).filter((f) => f.startsWith("libquery_engine-"))
      : [];
    const openssl11Engines = shippedEngines.filter(
      (f) => !f.includes("openssl") && f !== REQUIRED_ENGINE.replace(/^libquery_engine-/, ""),
    );
    if (openssl11Engines.length > 0) {
      fail(
        `deployed Prisma client contains OpenSSL-1.1-suffixed engine file(s): ` +
          `${openssl11Engines.join(", ")}`,
      );
    }

    // Cross-check: the exact path this app's Dockerfile pins via
    // PRISMA_QUERY_ENGINE_LIBRARY (bypassing Prisma's own runtime
    // platform auto-detection — the actual root cause of the
    // libssl.so.1.1 crash this script guards against) must point at a
    // real file inside the deployed artifact. Catches silent drift
    // between the Dockerfile's hardcoded path and whatever a future
    // Prisma/schema change actually names the generated engine.
    const dockerfilePath = join(repoRoot, app.dockerfile);
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const match = dockerfile.match(/PRISMA_QUERY_ENGINE_LIBRARY=(\S+)/);
    if (!match) {
      fail(
        `${app.dockerfile} does not set PRISMA_QUERY_ENGINE_LIBRARY — production would fall ` +
          `back to Prisma's own runtime platform auto-detection`,
      );
    } else {
      const pinnedPath = match[1].replace(/^\/app\//, "");
      const resolvedPinnedPath = join(deployDir, pinnedPath);
      if (existsSync(resolvedPinnedPath)) {
        pass(`${app.dockerfile}'s PRISMA_QUERY_ENGINE_LIBRARY points at a real deployed file`);
      } else {
        fail(
          `${app.dockerfile}'s PRISMA_QUERY_ENGINE_LIBRARY (${match[1]}) does not exist in the ` +
            `deployed artifact`,
        );
      }
    }
  } finally {
    rmSync(deployDir, { recursive: true, force: true });
  }
}

console.log();
if (failed) {
  console.error("Production packaging verification FAILED.");
  process.exit(1);
} else {
  console.log("Production packaging verification passed.");
  process.exit(0);
}
