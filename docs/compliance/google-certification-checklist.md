# Google Transparent Click Tracker — Submission Checklist

**Status: preparation only.** Nothing on this checklist means "Google has
certified this." It tracks what this codebase and its operator need in
place before a manual submission to Google can reasonably be made. Items
marked done reflect what this repository actually implements and tests
today, verified during Phase 12 — not a claim about the outcome of
Google's own review.

Some items are operator/deployment responsibilities this codebase cannot
complete on its own (a real domain, a real TLS certificate, the actual
Google Ads submission form) — those are marked accordingly rather than
checked off.

## Checklist

- [x] **Transparent destination parameter.** Every tracker redirect
      accepts and requires a `redirection_url` query parameter — see
      `apps/tracker/src/modules/tracker/tracker.routes.ts`.
- [x] **Immediate next hop transparency.** The `Location` header returned
      by the tracker is the exact, unmodified `redirection_url` value
      (same parsed `URL` object used for validation and for the redirect)
      — proven by `apps/tracker/test/google-transparency-compliance.test.ts`
      and the `pnpm compliance:test` tool.
- [x] **No hidden redirect destination.** `TrackingLink.destinationId`/
      `Destination` is never read by the redirect decision — see
      `docs/compliance/redirect-audit.md`.
- [x] **All tracking paths audited.** Every `redirect(`/`Location`/
      `destinationUrl`-shaped code path in the repository was searched
      for and classified — see `docs/compliance/redirect-audit.md`.
- [x] **Redirect destination validation.** `validateTransparentRedirectUrl`
      requires `http`/`https`, rejects userinfo/control characters/
      protocol-relative input, and bounds length — see
      `packages/shared/src/transparent-redirect.ts` and its test suite.
- [x] **Domain verification.** A `TrackingDomain` must be DNS-TXT-record
      `VERIFIED` and `isActive` before serving any tracker traffic,
      enforced at both the service layer and a Postgres `CHECK`
      constraint.
- [x] **Bot behavior documented.** `BOT` classification always routes to
      the campaign's Safe Page (or a controlled `404` if none is
      configured); never to the visible destination. See
      `docs/compliance/google-transparent-click-tracker.md#5-bot-handling`.
- [x] **Routing behavior documented.** Campaign-scoped routing rules can
      only resolve to `TARGET`/`SAFE_PAGE`/`BLOCK` — never an arbitrary
      URL. See `docs/architecture/rules-routing.md` and
      `docs/compliance/google-transparent-click-tracker.md#6-routing`.
- [x] **Affiliate attribution documented.** Recorded internally
      (`Click.affiliatePartnerId`), never read by the redirect decision.
      See `docs/architecture/affiliate-partners.md`.
- [x] **Security review completed.** See
      `docs/architecture/security.md` and this phase's findings in
      `docs/compliance/redirect-audit.md`.
- [x] **Privacy/data handling documented.** See
      `docs/compliance/google-transparent-click-tracker.md#10-data-handling`
      — raw IP addresses are never stored, only a salted one-way hash.
- [x] **Test URLs prepared.** See "Evidence to provide" below for the
      exact example URL shapes; a live, resolvable example additionally
      requires a deployed instance with a real verified domain (an
      operator responsibility — see below).
- [ ] **Tracking domain ownership.** Requires a real domain the operator
      controls, with a DNS TXT record proving ownership (Phase 2's
      verification flow) — this is an operator action, not something this
      codebase can complete on its own. The mechanism is implemented and
      tested (`apps/api/test/domains-lifecycle.test.ts`); no specific
      domain has been verified as part of this phase.
- [ ] **HTTPS.** The application supports and expects `https://` tracking
      URLs and destinations; TLS termination (a real certificate on a
      real domain) is an operator/deployment responsibility
      (`TrackingDomain.sslStatus` intentionally stays `NOT_CONFIGURED`
      until an operator provisions one — see
      `docs/compliance/google-transparent-click-tracker.md#12-known-limitations`).
- [ ] **Production environment ready.** Requires an operator to deploy
      `apps/api`/`apps/tracker`/`apps/dashboard` with production
      configuration (see `.env.example` and
      `docs/architecture/security.md`'s configuration guidance) — not
      completed as part of this phase, which prepares the codebase, not a
      live deployment.
- [ ] **Certification application information prepared.** The
      documentation in this directory is written to be attachable to a
      real submission, but the submission itself (Google's application
      form, business/contact details, the specific domain(s) being
      submitted) is an operator action outside this repository's scope.

## Running `pnpm compliance:test` against a real deployment

`pnpm compliance:test -- --remote` requires `TRACKER_URL` (the deployment
to test against). By default it only runs the checks that don't need a
known, real tracking slug — connectivity, missing-parameter rejection,
dangerous-protocol rejection, unknown-slug handling. Three further
environment variables, all optional, extend it to a real tracking link
the operator controls:

- **`COMPLIANCE_TEST_HOSTNAME`** and **`COMPLIANCE_TEST_SLUG`** — when
  BOTH are set, the tool sends a real request to `TRACKER_URL` for
  `/<COMPLIANCE_TEST_SLUG>?redirection_url=...`, with an explicit
  `Host: <COMPLIANCE_TEST_HOSTNAME>` header (independent of whatever
  host `TRACKER_URL` itself resolves to, the same virtual-hosting
  technique a CDN or load balancer uses), and verifies the immediate
  HTTP response is a 3xx redirect whose `Location` header is exactly the
  `redirection_url` the tool sent — the same check LOCAL mode always
  runs, now proven against a live instance instead of an in-process one.
- **`COMPLIANCE_TEST_SAFE_PAGE_URL`** — when set alongside the two
  above, additionally sends a bot-classified request to the same
  tracking link and verifies it redirects to exactly this URL. This
  check only runs when the expected Safe Page URL is supplied
  explicitly by the operator; the tool never guesses at what a real
  deployment's Safe Page is configured to, so without this variable the
  check is reported as SKIPPED, not assumed to pass.

Whatever tracking link is referenced by `COMPLIANCE_TEST_HOSTNAME`/
`COMPLIANCE_TEST_SLUG` must already exist, be `ACTIVE`, and belong to a
`VERIFIED`/active `TrackingDomain` — the tool only issues `GET` requests
against the tracker's own redirect endpoint, never any admin/mutating
API, so it cannot create, verify, or activate a tracking link on the
operator's behalf. Checks that would require mutating real production
state to observe (deactivating a live domain, for example) stay
deliberately unimplemented and reported as SKIPPED — see
`apps/tracker/scripts/compliance-test.ts`'s own header comment for the
exact behavior.

## Evidence to provide

When an operator is ready to submit, the following evidence is
straightforward to produce from a real deployment using the materials in
this repository — none of it is fabricated here, since a real submission
needs evidence from an actual live instance:

- **Tracker URL** — the operator's own verified tracking domain plus a
  real slug, e.g. `https://track.yourdomain.com/<slug>`.
- **Visible `redirection_url` example** — e.g.
  `https://track.yourdomain.com/<slug>?redirection_url=https://yourdomain.com/landing`.
- **HTTP redirect response** — captured with `curl -sI` (no `-L`, so the
  redirect isn't auto-followed) against the URL above, showing the exact
  `Location` header. The same shape is already proven deterministically
  by `pnpm compliance:test` and
  `apps/tracker/test/google-transparency-compliance.test.ts` against a
  local instance — see those for what the response looks like before
  reproducing it against a live deployment.
- **Final landing URL** — the advertiser page the `Location` header
  points to, reachable and rendering normally.
- **Domain ownership evidence** — the DNS TXT record created for Phase
  2's verification flow (`TrackingDomain.verificationToken`), and/or
  standard domain registrar ownership records.
- **Architecture diagram** — the flow diagram in
  `docs/compliance/google-transparent-click-tracker.md#2-transparent-redirect-flow`.
- **Security documentation** — `docs/architecture/security.md`,
  `docs/api/webhooks.md`, and this checklist.
- **Test results** — the exact `pnpm lint`/`pnpm typecheck`/
  `pnpm turbo run test --force`/`pnpm build`/`pnpm prisma migrate status`
  output recorded in this phase's pull request description, plus a fresh
  `pnpm compliance:test` run against the deployment being submitted.

Do not fabricate any of the above. Every item here should be produced
from an actual running instance and actual DNS/registrar records at
submission time — this document only prepares what to gather and where
each piece comes from.
