#!/usr/bin/env node
//
// Verifies that production Docker packaging (apps/api/Dockerfile,
// apps/tracker/Dockerfile) actually ships a working Prisma query engine
// for the real production runtime (node:20-alpine, musl libc, OpenSSL 3)
// — not just that `pnpm build`/`pnpm typecheck` pass, which say nothing
// about what `pnpm deploy` puts in the final image or which engine file
// the running container picks at startup.
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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// The engine actually needed by the real VPS: node:20-alpine on x86_64.
// See packages/database/prisma/schema.prisma's `binaryTargets` comment
// and apps/{api,tracker}/Dockerfile's PRISMA_QUERY_ENGINE_LIBRARY
// comment for the full "why" — this must never regress back to the
// legacy bare "linux-musl" (OpenSSL 1.1) engine, which crashes
// production with `Error loading shared library libssl.so.1.1`.
const REQUIRED_ENGINE = "libquery_engine-linux-musl-openssl-3.0.x.so.node";

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

    const enginePath = join(
      deployDir,
      "node_modules/@adstrackio/database/generated/client",
      REQUIRED_ENGINE,
    );
    if (existsSync(enginePath)) {
      pass(`deployed Prisma client contains ${REQUIRED_ENGINE}`);
    } else {
      fail(
        `deployed Prisma client is missing ${REQUIRED_ENGINE} — production would crash on ` +
          `node:20-alpine with a musl/OpenSSL query engine error`,
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
