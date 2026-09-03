# Production Tracker Verification (Phase 13)

The exact procedure and expected results for verifying a **real,
deployed** tracker instance before a Google certification submission.
This is the production-facing counterpart to
`docs/compliance/google-transparent-click-tracker.md` (which documents
the architecture and proves the behavior against a local/test instance)
— everything here is meant to be run against `https://<your-tracking-domain>`,
not `localhost`.

Nothing in this document should be run against production before its
domain has completed verification (`docs/deployment/production.md#4-real-tracking-domain-setup`)
and has at least one real, `ACTIVE` tracking link to test with.

## The core request

```
GET https://<tracking-domain>/<slug>?redirection_url=https://example.com/
```

### Expected

- **3xx response.** The tracker issues a `302 Found` on success.
- **`Location` is the exact, validated `redirection_url`.** Not a
  transformed, shortened, or re-encoded version of it — the same
  string, parsed once by `validateTransparentRedirectUrl`
  (`packages/shared/src/transparent-redirect.ts`) and redirected to
  using that same parsed `URL` object.
- **No hidden stored `Destination` overrides it.** The tracker's
  resolver never reads `TrackingLink.destinationId`/`Destination` at
  all — see `docs/compliance/redirect-audit.md` for the code-level
  proof. This is not something a production request can "expose" a
  failure of by itself; it is a structural property of the code, and
  this document's job is to confirm the deployed code is actually
  running that structure, not different code.
- **No intermediate tracker hop.** Exactly one HTTP response between
  the click and the visible `Location` header — inspect the raw
  response directly (`curl -sI`, or the compliance tool's
  `redirect: "manual"`/raw-socket approach below), never a client that
  auto-follows redirects, or an intermediate hop would go unnoticed.
- **No destination rewrite** beyond `validateTransparentRedirectUrl`'s
  existing safety checks (well-formed `http`/`https`, no userinfo, no
  control characters, bounded length — see that file). A destination
  passing those checks comes back unmodified.
- **Query parameters and fragments preserved.** Try a `redirection_url`
  containing both, e.g.
  `https://example.com/landing?utm_source=google&utm_campaign=x#section`
  — the `Location` header must contain them exactly.

## Failure-mode checks

Run these against the same production hostname/slug (or, where noted,
against any hostname/slug — the check doesn't depend on which):

| Request | Expected |
| --- | --- |
| Same slug, `redirection_url` omitted | `400`, no `Location` header — never falls back to a stored destination. |
| Same slug, `redirection_url=javascript:alert(1)` (or `data:`/`file:`/`vbscript:`) | `400` — dangerous protocols rejected before any domain/link lookup happens. |
| Any hostname, an unknown/nonexistent slug | `404` — no information leak about whether the domain itself is known. |
| A domain that has not completed verification | `404` — same uniform failure as an unknown slug; do not deploy a link on an unverified domain expecting it to work. |
| A domain that is `VERIFIED` but deactivated (`isActive: false`) | `404` — deactivating a domain immediately stops it serving tracker traffic. |
| A tracking link that is paused/archived (`status !== "ACTIVE"`) | `404`/`410` depending on the specific state — the link stops resolving, the domain/other links are unaffected. |
| Request with a bot-identifying User-Agent (e.g. `Googlebot/2.1 (+http://www.google.com/bot.html)`) against a link with a configured Safe Page | `302` to the **Safe Page** URL, never the visible `redirection_url` — this is the one documented, non-transparent exception, applied uniformly (see `docs/compliance/google-transparent-click-tracker.md#5-bot-handling`). |
| Same request with an ordinary browser User-Agent | `302` to the visible `redirection_url` — exactly the core-request behavior above, unaffected by the link having a Safe Page configured. |
| A request with a spoofed `cf-ipcountry`/`x-vercel-ip-country`/`cloudfront-viewer-country` header, no matching `x-adstrackio-edge-secret` | No effect on routing — COUNTRY routing conditions never match without `TRUSTED_EDGE_SECRET` configured and the matching header actually present (see `docs/architecture/rules-routing.md#country-signal-trust-boundary`). |
| Two identical requests through two different affiliate tracking links (different `affiliatePartnerId`) pointing at the same `redirection_url` | Both redirect to the identical `Location` — affiliate attribution is recorded internally (`Click.affiliatePartnerId`) but never changes the visible destination. |

## Running these checks: `pnpm compliance:test -- --remote`

Doing every row above by hand with `curl -sI` (below) is the ground
truth and worth doing at least once by hand before a submission. For
repeatable, scriptable verification, the same checks are automated in
`apps/tracker/scripts/compliance-test.ts`:

```sh
TRACKER_URL=https://track.yourdomain.com \
COMPLIANCE_TEST_HOSTNAME=track.yourdomain.com \
COMPLIANCE_TEST_SLUG=<a real, active slug on that domain> \
COMPLIANCE_TEST_SAFE_PAGE_URL=<that link's configured Safe Page, if any> \
pnpm compliance:test -- --remote
```

- `COMPLIANCE_TEST_HOSTNAME`/`COMPLIANCE_TEST_SLUG` (both required
  together) run the exact-redirect check above against that real link,
  sending an explicit `Host` header independent of whatever host
  `TRACKER_URL` itself resolves to.
- `COMPLIANCE_TEST_SAFE_PAGE_URL` additionally runs the BOT→Safe Page
  check — only when supplied, since the tool will not guess at what a
  real deployment's Safe Page is configured to.
- Every check that can run without those variables (missing parameter,
  dangerous protocol, unknown slug, basic connectivity) runs
  regardless.
- **Never follows redirects automatically** — every check inspects the
  raw HTTP response (`redirect: "manual"` for `fetch`-based checks,
  Node's core `http`/`https` modules for the Host-header-override
  checks, which `fetch` cannot send).
- **Never reports a fake PASS.** A check that cannot be run safely
  against a live deployment (inactive/unverified-domain behavior would
  require deactivating a real domain and disrupting live traffic) is
  reported `SKIP` with the specific reason, always — see
  `docs/compliance/google-certification-checklist.md#running-pnpm-compliancetest-against-a-real-deployment`
  for the full variable reference.
- The exact-redirect check additionally **prints the raw evidence**
  (method, path, `Host` header, HTTP status, `Location` header) to
  stdout unconditionally — pass or fail — so a real run's output can be
  pasted directly into a certification submission as the literal
  "immediate HTTP Location evidence" Google's review asks for. See
  `docs/compliance/google-certification-evidence.md`.

## Doing it by hand with `curl`

For a human-readable spot check, or to generate evidence independent of
this repository's own tooling:

```sh
# The core request — inspect headers only, DO NOT follow the redirect.
curl -sI "https://track.yourdomain.com/<slug>?redirection_url=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("https://example.com/landing?utm_source=google#section", safe=""))')"

# Expect output containing:
#   HTTP/2 302
#   location: https://example.com/landing?utm_source=google#section

# Missing redirection_url:
curl -sI "https://track.yourdomain.com/<slug>"
# Expect: HTTP/2 400, no location header.

# Dangerous protocol:
curl -sI "https://track.yourdomain.com/<slug>?redirection_url=javascript%3Aalert(1)"
# Expect: HTTP/2 400.

# Unknown slug:
curl -sI "https://track.yourdomain.com/definitely-does-not-exist?redirection_url=https%3A%2F%2Fexample.com%2Fx"
# Expect: HTTP/2 404.
```

`curl -I` alone does not follow redirects (that requires the separate
`-L` flag, which must never be added for these checks) — the `Location`
header in `curl -sI`'s output is exactly the immediate response the
brief asks for, with no auto-following masking a hidden intermediate
hop.

## What this document does not claim

Every expected result above was verified against this codebase's
architecture and against a local/in-process instance (see
`apps/tracker/test/google-transparency-compliance.test.ts` and a real
`pnpm compliance:test` run — both pass; see
`docs/compliance/production-readiness.md`). **No real production
tracking domain was deployed and verified against as part of this
phase** — this document is the procedure to run once one exists, not a
report that it has already been run. Do not treat this document as
evidence that a live deployment has been checked; run the commands
above against your own deployment and keep the actual output as your
evidence.
