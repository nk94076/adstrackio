# Google Transparent Click Tracker — Compliance Notes

## Status: not certified, not yet implemented

**AdstrackIO has not applied for, and does not hold, Google Transparent
Click Tracker certification.** No part of this codebase should be
represented to Google, to customers, or in any documentation as certified
or as implementing certified behavior. This document exists to record the
compliance-relevant architectural decisions made in Phase 1 so that when
Phase 3 (Transparent Click Tracker) and Phase 12 (Google Certification
Preparation & Submission) are implemented, they build on a foundation that
was designed with certification requirements in mind from the start —
rather than requiring a retrofit.

## What Phase 1 has actually built

- A **data model boundary** between:
  - internal attribution/configuration data (`ReferralConfiguration`,
    `ReferralProof`, `Campaign`, `AuditLog`) — used for AdstrackIO's own
    reporting and partner-attribution record-keeping, and
  - the future Google-facing redirect path (`TrackingDomain`,
    `TrackingLink`, `Destination`), which Phase 3 will use to serve actual
    HTTP redirects.

  These are separate models with separate services. Nothing in Phase 1
  merges "how we label traffic internally" with "what URL we redirect a
  click to."

- A **process/service boundary**: `apps/tracker` is a separate Fastify
  application from `apps/api` (see
  `docs/architecture/overview.md#why-appstracker-is-a-separate-service-from-appsapi`).
  This exists specifically so the future redirect engine's behavior can be
  reasoned about and audited independently of the admin/dashboard API
  surface.

- An explicit **interface contract** for click resolution,
  `TrackingResolver` (`packages/shared/src/tracking-resolver.ts`), that
  Phase 3 must implement. Its documented contract: resolution is based
  **solely on the tracking link's own configured Destination** — looked
  up from the database by `(hostname, slug)` — never on request
  parameters, query strings, or any other client-supplied value that could
  substitute a different destination. The current implementation
  (`NotImplementedTrackingResolver`) unconditionally rejects, so there is
  no code path today that could be mistaken for a working (or worse,
  subtly wrong) redirect.

## Requirements this document commits future phases to

These are binding constraints for whoever implements Phase 3 and Phase 12,
not just descriptive notes:

1. **No arbitrary open redirect.** The redirect target must always be a
   `Destination` looked up via a `TrackingLink` that an authenticated
   organization member configured in advance. A tracking request must
   never be able to supply or influence the destination URL directly
   (e.g. via a `?redirect=` query parameter or similar). This is why
   `packages/shared/src/url.ts` explicitly documents that its validator is
   for destinations an org member configures, not for building a
   general-purpose "redirect to whatever the request says" helper.

2. **No deceptive destination substitution.** The system must never route
   a subset of traffic (e.g. based on user-agent, referrer, or perceived
   reviewer status) to a different final destination than what real users
   receive, in a way designed to present reviewers/crawlers with different
   content than end users would see for the same tracking link. This is
   distinct from legitimate, transparent bot handling: routing detected
   bot/automated traffic to a designated "safe page" (the Phase 5/8 bot
   routing policy referenced in `docs/architecture/data-model.md`) is a
   documented, deliberate policy applied uniformly by classification, not
   a mechanism for hiding the real destination from a specific reviewer.
   When Phase 3 and Phase 8 implement this, the policy and its criteria
   must be documented here, not left implicit in code.

3. **Custom referral/partner attribution requires evidence approval before
   it can affect any redirect behavior.** Phase 1 already enforces this at
   the data layer: a `CUSTOM_PARTNER_ATTRIBUTION` `ReferralConfiguration`
   cannot reach `status = ACTIVE` without an `APPROVED` `ReferralProof`,
   enforced in the service layer (see
   `docs/architecture/security.md#authorization`). Whatever Phase 3 builds
   must continue to gate any behavior driven by these configurations on
   that same `ACTIVE` status — it must not read from a
   `ReferralConfiguration` that hasn't cleared review.

4. **Internal attribution data must remain separate from Google-facing
   redirect semantics.** `ReferralConfiguration`/`ReferralProof` govern how
   AdstrackIO's own internal reporting labels and attributes traffic (e.g.
   for partner payout or reporting purposes). They must never be used to
   alter the `Referer` header or any other signal sent to Google or to the
   destination in a way that misrepresents where traffic actually came
   from. If a future phase needs to pass attribution data downstream, it
   must do so through an explicit, documented mechanism (e.g. a UTM
   parameter or postback field) — never by spoofing a browser-level signal.

5. **No fabricated verification status.** `TrackingDomain.verificationStatus`
   and `sslStatus` must only ever reflect real, checked state once Phase 2
   implements verification. Phase 1 defaults every domain to `PENDING` /
   `NOT_CONFIGURED` specifically so there is no path today where a domain
   appears "verified" without having been verified.

## Re-reading this document

Whoever implements Phase 3 or Phase 12 should re-read this document before
writing the redirect engine, and update it (not just the code) if any of
these constraints turn out to be wrong, incomplete, or in tension with an
actual Google requirement discovered during certification prep.
