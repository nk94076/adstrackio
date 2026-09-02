# Google Transparent Click Tracker — Compliance Notes

## Status: not certified

**AdstrackIO has not applied for, and does not hold, Google Transparent
Click Tracker certification.** No part of this codebase should be
represented to Google, to customers, or in any documentation as certified
or as implementing certified behavior. Phase 3 (Transparent Click Tracker)
is implementation groundwork for a future certification effort
(Phase 12: Google Certification Preparation & Submission) — it establishes
the redirect architecture the certification review will examine, not a
finished, submitted, or approved integration.

## The core architectural decision: a visible, request-supplied destination

Phase 1 originally sketched a different design: the tracker would resolve
`(hostname, slug)` to a `TrackingLink`'s own backend-configured
`Destination` and redirect there, with the destination never appearing in
the tracking URL itself. Phase 3 deliberately replaced that design with
the one actually implemented:

```
https://track.example.com/abc123?redirection_url=https://example.com/offer
```

The `redirection_url` query parameter, not a backend lookup, **is** the
immediate next hop. This is what "transparent" means here: the destination
is plainly visible in the URL a reviewer (human or automated) can inspect,
rather than hidden behind an opaque backend identifier that only the
tracker's own database can resolve. `apps/tracker`'s route handler
(`modules/tracker/tracker.routes.ts`):

1. Validates `redirection_url` with a single canonical parser
   (`validateTransparentRedirectUrl`, `packages/shared/src/transparent-redirect.ts`)
   — http(s) only, no userinfo, no control characters, bounded length.
2. Redirects to the **exact string that validator returns** — the same
   parse used to validate is the same string redirected to. Two different
   parsers (or a parse-then-reserialize mismatch) disagreeing about what
   the "real" destination is is a known class of open-redirect/SSRF bug;
   using one function for both steps closes it by construction.
3. Never fetches that URL server-side. The only outbound action taken is
   an HTTP redirect (a `Location` header); nothing in this codebase makes
   a server-side request to `redirection_url`, which is what would create
   an SSRF risk.
4. Never substitutes it. `TrackingLink.destinationId` (and the
   `Destination` it points to) is **not** used to pick the redirect
   target in Phase 3 — it exists in the schema for administrative/
   reporting purposes and as a placeholder for a possible future
   non-transparent mode, but the live tracker route ignores it entirely
   when deciding where to send a human visitor. See
   `docs/architecture/data-model.md` for how this is documented at the
   schema level.

### This is a known, deliberate open-redirect-shaped design

Be precise about what this means operationally: **any request to a
verified, active tracking link can redirect a visitor to any http(s) URL
named in `redirection_url`.** That is the textbook shape of an open
redirect. It is intentional, not an oversight — several real-world
"transparent" ad-tracking systems work exactly this way, specifically
*because* hiding the destination behind a backend ID is the behavior
Google's transparency requirement exists to rule out. What this
architecture restricts is the URL's **form** (must be a well-formed,
control-character-free http(s) URL with no userinfo — see
`transparent-redirect.ts`), not its **host** — restricting the host would
defeat the point of a visibly-inspectable destination.

The practical implication: a verified tracking domain's reputation is only
as trustworthy as what its owner allows people to construct links with.
Mitigating abuse of this capability (traffic-source review, monitoring,
takedown of abused links) is an operational/organizational control, not
something the tracker's URL validation can solve without reintroducing the
opaque-destination pattern this design exists to avoid.

## What Phase 3 has actually built

- **`apps/tracker`'s real `GET /:slug` route** (previously a `501` stub).
  Resolves the request hostname to a `TrackingDomain`, requires
  `verificationStatus = VERIFIED` and `isActive = true` (Phase 2's
  activation invariant, reused rather than re-checked ad hoc — see
  `docs/architecture/security.md#domain-activation-invariant`), then
  resolves `(trackingDomainId, slug)` to an active `TrackingLink`.
  Unknown/unverified/inactive domains and unknown links return a uniform
  `404`; a link that exists but is `PAUSED`/`ARCHIVED` returns `410`, to
  avoid leaking *why* a domain doesn't serve traffic while still letting a
  legitimate integrator distinguish "never existed" from "deliberately
  retired."
- **The redesigned `TrackingResolver` contract**
  (`packages/shared/src/tracking-resolver.ts`). It no longer returns a
  `destinationUrl` — resolving *identity and authorization* (does this
  hostname+slug belong to a servable, verified, active tracking link, and
  which organization/campaign owns it) is a different concern from
  *selecting a destination*, which Phase 3's architecture deliberately
  does not do server-side. `PrismaTrackingResolver`
  (`apps/tracker/src/modules/tracker/prisma-tracking-resolver.ts`) is the
  real implementation; it also re-asserts organization ownership
  (`campaign.organizationId === domain.organizationId`) as defense in
  depth, even though `apps/api`'s write path already guarantees it.
- **Bot routing.** `HeuristicBotDetectionEngine`
  (`apps/tracker/src/modules/bot-detection/heuristic-bot-detection-engine.ts`)
  is the implementation of the pre-existing `BotDetectionEngine` interface
  (`packages/shared/src/bot-detection.ts`) — a multi-signal but still
  explicitly provisional heuristic (Phase 5: Bot Detection Integration),
  not a production-grade or ML-based detector. Classification is computed
  entirely server-side from the request's own `User-Agent` header and a
  small, explicit whitelist of other headers; no request parameter can
  assert its own bot/human status, override the score, or supply its own
  reason codes. Traffic classified `BOT` is always sent to the campaign's
  server-configured `safePageUrl` (`Campaign.safePageUrl`, Phase 3's Safe
  Page foundation) instead of the transparent destination; if none is
  configured, the tracker returns a controlled `404` rather than guessing
  or falling back to a hidden destination. This routing decision is
  **internal** — it changes where the *response* goes, but it never
  changes or hides what `redirection_url` in the *request* said the
  immediate next hop was. `SUSPICIOUS` and `UNKNOWN` classifications
  (Phase 5) now route through the campaign's own configured policy
  (`Campaign.suspiciousTrafficPolicy`/`unknownTrafficPolicy`: `SAFE_PAGE`,
  `TARGET`, or `BLOCK`; defaulting to `TARGET`, the implicit behavior
  every campaign had before this field existed) instead of being
  unconditionally treated as servable — see
  `docs/architecture/bot-detection.md` for the full policy model. A
  `BLOCK` verdict, like `SAFE_PAGE` with none configured, returns a
  controlled `404` — never a hidden destination.
- **Click logging.** Every resolved request writes a `Click` row (with a
  separately-generated, CSPRNG `crypto.randomUUID()` id — not appended to
  the outward redirect URL, kept purely internal) and a corresponding
  `BotEvent`, following the existing schema split
  (`docs/architecture/data-model.md`). No raw IP address is stored, only a
  salted one-way hash (`packages/shared/src/ip-hash.ts`).

## Requirements this document commits future phases to

1. **The visible `redirection_url` parameter is the immediate next hop,
   and the tracker must keep following it — not resolve a hidden backend
   destination instead.** This supersedes Phase 1's original "resolution
   must be based solely on the tracking link's own configured destination"
   requirement, which assumed the opposite architecture. Any future phase
   that changes how destinations are chosen must update this document
   before changing the code, not after.

2. **No deceptive destination substitution.** The system must never route
   a subset of traffic (e.g. based on perceived reviewer status) to a
   different final destination than what the same tracking link's real
   visitors receive, in a way designed to present reviewers/crawlers with
   different content. Routing detected bot/automated traffic to a
   designated Safe Page is different in kind: it's a uniform,
   classification-based policy (see above), not a mechanism for hiding the
   real destination from a specific reviewer — a human reviewer is not a
   bot and is not routed to the Safe Page.

3. **Custom referral/partner attribution requires evidence approval before
   it can affect any redirect behavior.** Unchanged from Phase 1: a
   `CUSTOM_PARTNER_ATTRIBUTION` `ReferralConfiguration` cannot reach
   `status = ACTIVE` without an `APPROVED` `ReferralProof` (see
   `docs/architecture/security.md#authorization`). Phase 3's tracker does
   not read `ReferralConfiguration` at all yet; if a future phase makes
   tracker behavior depend on it, that dependency must gate on `ACTIVE`.

4. **Internal attribution data must remain separate from Google-facing
   redirect semantics.** `ReferralConfiguration`/`ReferralProof` govern
   AdstrackIO's own internal reporting labels; they must never be used to
   alter the `Referer` header or any other signal sent to the destination
   in a way that misrepresents where traffic came from.

5. **No fabricated verification status.** `TrackingDomain.verificationStatus`
   only ever reflects a real, server-performed DNS TXT-record check
   (Phase 2), and `isActive` requires it, enforced at both the service
   layer and a Postgres `CHECK` constraint. Phase 3's tracker relies on
   this and re-checks it on every request rather than caching a stale
   verdict.

6. **Destination validation happens server-side, and the server never
   fetches the destination.** `validateTransparentRedirectUrl` runs on
   every request; the only network action the tracker takes as a result
   of a redirect decision is issuing an HTTP redirect. There is no code
   path anywhere in `apps/tracker` that makes an outbound HTTP request to
   `redirection_url` or to a Safe Page URL.

7. **Bot routing must not hide the immediate next hop from the
   Google-facing URL architecture.** The Safe Page mechanism (and, Phase
   5, the `BLOCK` policy action) changes *where the response points*,
   never *what the request's own `redirection_url` said* — a reviewer
   inspecting the request/response pair can always see both the visible
   destination the request asked for and, for `TARGET`-routed traffic
   (always the case for `HUMAN`), that the tracker honored it. `BLOCK`
   never substitutes a hidden destination either — it returns the same
   controlled `404` as an unconfigured Safe Page, not a redirect anywhere.

## Known limitations (tracked, not hidden)

- **No rate limiting on the tracker route.** Deliberately deferred — see
  `docs/architecture/security.md` known limitations.
- **No SSL/TLS certificate provisioning.** `TrackingDomain.sslStatus`
  remains `NOT_CONFIGURED`; not fabricated.
- **`HeuristicBotDetectionEngine` is a multi-signal but still
  explicitly-provisional heuristic** (Phase 5), not a production-grade or
  ML-based bot-detection capability. A future non-heuristic engine can
  still be dropped in through the same `BotDetectionEngine` interface —
  see `docs/architecture/bot-detection.md`.
- **Campaign status does not gate traffic.** Only `TrackingDomain`
  verification/activation and `TrackingLink.status` gate whether a request
  resolves; a `DRAFT`/`PAUSED`/`ARCHIVED` campaign's still-`ACTIVE`
  tracking links continue to serve traffic. Revisit if that turns out to
  be wrong.

## Re-reading this document

Phase 5 (Bot Detection Integration) re-read this document before wiring
`SUSPICIOUS`/`UNKNOWN` classifications into the routing decision (see
requirement 7 and the "Bot routing" section above, both updated in that
phase) and confirmed no core transparency requirement changed — only the
previously-undefined routing behavior for two classifications was made
explicit and campaign-configurable. Whoever implements Phase 8 (Rules &
Routing Engine) or Phase 12 (Google Certification Preparation) should
re-read this document before changing tracker behavior, and update it —
not just the code — if any of these constraints turn out to be wrong,
incomplete, or in tension with an actual Google requirement discovered
during certification prep.
