# Campaign Manager (Phase 6)

## Status and scope

Phase 6 turns `Campaign` and `TrackingLink` from unguarded CRUD rows
(create/list/get/update, with any field — including `status` — writable by
any authorized caller) into a real control plane: an explicit status
lifecycle enforced in the backend, domain/destination assignment rules
that close gaps Phase 1-5 left open, and tracking-link management nested
under the campaign it belongs to.

Phase 6 is **control-plane work only**. It does not touch, and does not
need to touch, `apps/tracker` (the actual redirect endpoint), the
`BotDetectionEngine`/`resolveBotRoutingAction` classification pipeline
(Phase 5), or the Google Transparent Click Tracker `redirection_url`
architecture (Phase 3) — see "Relationship with the tracker" below for why
that's a deliberate boundary, not an oversight. No new bot detector was
built, no rate limiting was added, and Phase 8's Rules & Routing Engine
remains out of scope — a campaign's bot-traffic policy is still the same
two enum fields Phase 5 introduced.

## What existed before this phase (audit summary)

Before Phase 6:

- `Campaign.status` (`DRAFT`/`ACTIVE`/`PAUSED`/`ARCHIVED`) and
  `TrackingLink.status` (`ACTIVE`/`PAUSED`/`ARCHIVED`) were plain enum
  columns writable through the generic `PATCH .../campaigns/:id` and
  `PATCH .../tracking-links/:id` endpoints — any value was accepted, in
  any order, with no concept of a "legal transition." A client could PATCH
  an `ARCHIVED` campaign back to `ACTIVE` in one call.
- `assertBelongsToOrg`/`assertOwnedByOrg` (the campaign/tracking-link
  services' internal helpers) checked that a `trackingDomainId`/
  `destinationId` belonged to the caller's organization, but **not**
  that the domain was actually usable — a campaign could be configured to
  point at a `PENDING`/unverified or deliberately deactivated
  `TrackingDomain`, which would only surface as a failure at the tracker
  on the customer's first real click (`domain_not_verified`/
  `domain_inactive` — see `apps/tracker/src/modules/tracker/
  prisma-tracking-resolver.ts`).
- Tracking links were only reachable through flat,
  organization-scoped routes (`/organizations/:organizationId/
  tracking-links...`) — there was no way to ask "the links for this
  campaign" without listing everything and filtering client-side, and no
  route-level guarantee that a link ID actually belonged to the campaign a
  UI thought it was showing.

Everything else audited (organization/RBAC model, `AuditLog` architecture,
`ApiError`/Zod validation conventions, `TrackingResolver`) needed no
changes — Phase 6 builds directly on top of it.

## Campaign lifecycle

```
DRAFT ──activate──> ACTIVE ──pause───> PAUSED
  │                    │                  │
  └──archive──> ARCHIVED <──archive───────┘
                   ▲
                   └──────────archive──────── (from ACTIVE or PAUSED)

ACTIVE ──activate──> ACTIVE   (PAUSED -> ACTIVE: resume)
ARCHIVED: terminal — no transition out, to anything.
```

The state machine lives in `packages/shared/src/campaign-lifecycle.ts`
(`assertValidCampaignStatusTransition`) — pure, synchronous, no I/O,
following the same small-explicit-module pattern as
`bot-traffic-policy.ts`. Legal transitions:

- `DRAFT -> ACTIVE`, `DRAFT -> ARCHIVED`
- `ACTIVE -> PAUSED`, `ACTIVE -> ARCHIVED`
- `PAUSED -> ACTIVE`, `PAUSED -> ARCHIVED`
- `ARCHIVED` is terminal — every transition out of it is rejected,
  including back to `DRAFT`. A campaign that's done is done; reactivating
  it would misrepresent when it actually ran.
- A status transitioning to itself (e.g. calling `activate` on an
  already-`ACTIVE` campaign) is treated as a legal no-op — idempotent,
  no audit entry written, matching the precedent
  `verifyTrackingDomain`/`activateTrackingDomain` (Phase 2) already set for
  "calling this twice shouldn't be an error."

Enforcement is entirely in `campaigns.service.ts`
(`transitionCampaignStatus`, shared by `activateCampaign`/`pauseCampaign`/
`archiveCampaign`), **never only in the dashboard**: the three explicit
endpoints (`POST .../activate`, `.../pause`, `.../archive`) are the only
way to change `status`, each validating the transition before writing
anything and — same race-safety pattern as `activateTrackingDomain`
(Phase 2) — applying it via a conditional `updateMany` guarded on the
status just read, so a concurrent transition can't be silently clobbered
(surfaces as a `409` asking the caller to retry, rather than corrupting
state). An illegal transition returns `409 CONFLICT` with a message
naming the current and requested status
(`InvalidCampaignStatusTransitionError`).

**Creation is also constrained.** A campaign can only be created directly
`DRAFT` or `ACTIVE` (`CREATABLE_CAMPAIGN_STATUSES`) — creating one
directly `PAUSED` or `ARCHIVED` would fabricate a history the campaign
never actually had, and is rejected with `400 VALIDATION_ERROR`.

**The generic `PATCH .../campaigns/:id` no longer accepts `status` at
all** — `updateCampaignSchema` (`packages/validation/src/campaigns.ts`)
has no `status` field; a `status` key in the request body is silently
stripped by Zod's default parsing, the same as any other unrecognized
field, rather than changing anything.

## Tracking link lifecycle

Same shape, three statuses instead of four (no `DRAFT` — a tracking link
is either serving traffic, deliberately paused, or retired):

- `ACTIVE -> PAUSED`, `ACTIVE -> ARCHIVED`
- `PAUSED -> ACTIVE`, `PAUSED -> ARCHIVED`
- `ARCHIVED` is terminal.

Lives in `packages/shared/src/tracking-link-lifecycle.ts`
(`assertValidTrackingLinkStatusTransition`), enforced the same way in
`tracking-links.service.ts` (`transitionTrackingLinkStatus`, shared by
`activateTrackingLink`/`pauseTrackingLink`/`archiveTrackingLink`), with the
same conditional-`updateMany` race safety, the same `409` on an illegal
transition, and the same "no `status` in the generic `PATCH`" rule
(`updateTrackingLinkSchema` only accepts `destinationId`/`metadata`).
Creation is restricted to `ACTIVE`/`PAUSED` (`CREATABLE_TRACKING_LINK_
STATUSES`) — `ARCHIVED` is not a valid starting state.

**Reactivating a link is treated as "adding new traffic," same as
creating one** — see "Interaction with the campaign lifecycle" below.

This is a deliberate, isolated per-link on/off switch: pausing or
archiving one tracking link does not touch any other link under the same
campaign, and — as documented below — a campaign's own status does not
cascade to its links either. Each is controlled independently.

## Domain / destination assignment constraints

`apps/api/src/modules/shared/org-scoped-refs.ts` centralizes what Phase
1-5 had as two near-identical `assertBelongsToOrg`/`assertOwnedByOrg`
helpers (one in `campaigns.service.ts`, one in
`tracking-links.service.ts`), and extends the domain check:

- **`assertTrackingDomainAssignable`** — the `TrackingDomain` must belong
  to the caller's organization (existing IDOR boundary, unchanged) **and**
  now must be `verificationStatus === "VERIFIED"` **and** `isActive`. A
  domain that fails either check can never actually resolve a request
  (`PrismaTrackingResolver` rejects it with `domain_not_verified`/
  `domain_inactive`), so this catches a dead-on-arrival configuration at
  write time instead of a customer's first click. Applies to
  `Campaign.trackingDomainId` (create and update) and
  `TrackingLink.trackingDomainId` (create only — a link's domain is
  immutable after creation, unchanged from Phase 1-5).
- **`assertDestinationAssignable`** — organization ownership only, same as
  before; `Destination.isActive` is not checked here (out of Phase 6's
  stated scope — see "Known limitations").
- **`assertCampaignAcceptsNewOrReactivatedLinks`** — used when creating a
  `TrackingLink` or reactivating a `PAUSED` one: the `Campaign` must exist
  in-org and must not be `ARCHIVED`. An `ARCHIVED` campaign is a closed
  chapter; it cannot gain new active traffic infrastructure. Config-only
  changes to an existing link (e.g. `destinationId`) are not gated by
  this.

**An `ACTIVE` campaign's `trackingDomainId` cannot be changed at all** —
`updateCampaign` rejects the attempt with `409 CONFLICT`; the campaign
must be paused first. This was a deliberate choice between two options the
brief allowed (reject outright, vs. require an explicit pause first) —
reject was chosen because it's the simpler invariant to reason about and
test, and because a domain change is rare enough operationally that
requiring an explicit pause step first is not a meaningful UX cost.
`destinationId` and `safePageUrl` are **not** gated the same way: neither
is read by the tracker's actual redirect decision (Phase 3's
request-supplied `redirection_url` architecture — see
`docs/compliance/google-transparent-tracker.md`), so changing them cannot
break an in-flight resolution the way `trackingDomainId` can.

## Interaction with the campaign lifecycle (and what deliberately doesn't happen)

**`Campaign.status` does not cascade to its `TrackingLink`s, and does not
itself gate tracker traffic.** Pausing or archiving a campaign does *not*
automatically pause or archive its tracking links — those stay exactly as
they were, and (per "Relationship with the tracker" below) the tracker
never reads `Campaign.status` at all. This is a deliberate Phase 6
boundary: cascading status changes, or wiring `Campaign.status` into the
tracker's resolution path, would touch `apps/tracker` and the
`TrackingResolver` contract — explicitly out of scope for a control-plane
phase ("Do not change the transparent redirect contract"). The two levers
that already gate traffic — `TrackingLink.status` and `TrackingDomain`
verification/activation — are unchanged and remain the actual on/off
switches a customer's traffic responds to; `Campaign.status` is
organizational/reporting state layered on top. An operator who wants to
actually stop a campaign's traffic must pause its tracking links (or its
domain), not just the campaign — see "Known limitations" for the
consequence of this and why it was accepted rather than fixed here.

The one place the two lifecycles *do* interact is the guard described
above: an `ARCHIVED` campaign cannot gain new active tracking links
(neither by creation nor by reactivating a `PAUSED` one), preventing new
traffic infrastructure from being set up under a campaign that's
supposed to be finished.

## RBAC

Matches the existing linear role hierarchy (`OWNER > ADMIN > MEMBER >
VIEWER`, `packages/auth/src/roles.ts`) and the precedent Phase 2 set for
domain `activate`/`deactivate`:

| Action | Minimum role |
| --- | --- |
| List / get campaign or tracking link | `VIEWER` |
| Create / update campaign or tracking link (config only) | `MEMBER` |
| `activate` / `pause` / `archive` (campaign or tracking link) | `ADMIN` |

Lifecycle actions sit one tier above configuration changes because
starting, stopping, or permanently retiring a campaign's live traffic is a
bigger blast radius than editing its name or Safe Page URL — the same
reasoning Phase 2 applied to domain activation. No new role, no per-action
permission matrix, and no privilege expansion beyond what Phase 1's
`requireOrganizationMember(minimumRole)` preHandler already provides.

## Organization isolation

Unchanged IDOR boundary (every campaign/tracking-link/domain/destination
lookup is scoped to `organizationId`, verified server-side, never trusted
from the client), extended with one more relationship: the nested routes
(`/organizations/:organizationId/campaigns/:campaignId/tracking-links/
:trackingLinkId`) additionally require the link to belong to *that*
campaign specifically (`getTrackingLinkForCampaign`), not merely to *some*
campaign in the organization. A tracking link that exists, in-org, under a
different campaign 404s through the "wrong" campaign's URL rather than
being returned or modified — see
`apps/api/test/campaign-manager.test.ts` ("wrong campaign/link
relationship") and `docs/architecture/security.md#campaign-manager-apps-api-phase-6`.

## Audit events

Using the existing `AuditLog` architecture
(`apps/api/src/modules/audit-logs/audit-log.service.ts`) — namespaced
free-text `action` strings, written inside the same transaction as the
mutation they describe, never containing secrets/tokens/raw IPs:

- `campaign.created`, `campaign.updated`, `campaign.activated`,
  `campaign.paused`, `campaign.archived`
- `tracking_link.created`, `tracking_link.updated`,
  `tracking_link.activated`, `tracking_link.paused`,
  `tracking_link.archived`

Lifecycle events carry `{ from, to }` metadata (the previous and new
status) for operational investigation; `created` events carry enough to
identify what was created (`name`/`status` for a campaign, `slug`/
`campaignId` for a tracking link) without echoing the full request body.

## API endpoints

All under the existing versioned prefix
(`/api/v1/organizations/:organizationId/...`), using the existing
`fastify.authenticate` + `fastify.requireOrganizationMember(minimumRole)`
preHandlers:

```
GET    /campaigns
POST   /campaigns
GET    /campaigns/:campaignId
PATCH  /campaigns/:campaignId
POST   /campaigns/:campaignId/activate
POST   /campaigns/:campaignId/pause
POST   /campaigns/:campaignId/archive

GET    /campaigns/:campaignId/tracking-links
POST   /campaigns/:campaignId/tracking-links
GET    /campaigns/:campaignId/tracking-links/:trackingLinkId
PATCH  /campaigns/:campaignId/tracking-links/:trackingLinkId
POST   /campaigns/:campaignId/tracking-links/:trackingLinkId/activate
POST   /campaigns/:campaignId/tracking-links/:trackingLinkId/pause
POST   /campaigns/:campaignId/tracking-links/:trackingLinkId/archive
```

The pre-existing flat, organization-scoped tracking-link routes
(`/organizations/:organizationId/tracking-links...` — list/get/update, no
lifecycle actions) are **kept, not removed**, for the existing "all
tracking links across the organization" dashboard view; both surfaces
resolve to the same underlying rows and the same service functions. The
lifecycle `activate`/`pause`/`archive` actions are additionally exposed on
the flat surface too, for parity.

The lifecycle endpoints take **no request body** — the target status is
implied entirely by the endpoint (`/activate` always means "attempt
`ACTIVE`"), so there is nothing for a client to forge there; validation is
purely "is the current status allowed to make this transition."

## Dashboard changes

`/campaigns` (list): lifecycle action buttons (Activate/Pause/Archive,
shown only for legal transitions from the campaign's current status) and
a "Manage" link to a new detail page, gated on the caller's role
(`ADMIN`/`OWNER` for lifecycle actions, `MEMBER` and above for
create/edit — a `VIEWER` sees a read-only list with no forms or buttons).

`/campaigns/[id]` (new): campaign configuration (name, tracking domain,
destination, Safe Page URL, SUSPICIOUS/UNKNOWN policy) with the same
role-gated edit form, lifecycle action buttons, and a tracking-link
management panel scoped to that campaign (create/list, with per-link
lifecycle actions) using the nested API routes above. The tracking-domain
dropdown is disabled while the campaign is `ACTIVE`, mirroring the backend
restriction, so a `VIEWER`/`MEMBER` isn't shown a control that would just
`409`.

The dashboard's own transition-availability table (which buttons to show)
is a display-only mirror of `packages/shared/src/campaign-lifecycle.ts`/
`tracking-link-lifecycle.ts` — kept in sync manually since the dashboard
doesn't import backend code. It is **not** the enforcement point: the
backend re-validates every transition regardless of what the UI showed,
per "Campaign lifecycle" above.

## Relationship with the tracker

Nothing in `apps/tracker` changed. `PrismaTrackingResolver` still resolves
`(hostname, slug)` to a `TrackingLink` purely via `TrackingDomain.
hostname` + `TrackingLink.(trackingDomainId, slug)`, checks
`TrackingDomain.verificationStatus`/`isActive` and `TrackingLink.status`
exactly as Phase 2/3 established, and never reads `Campaign.status` at
all — see "Interaction with the campaign lifecycle" above for why. The
Google Transparent Click Tracker architecture (the request's own
`redirection_url` is the immediate next hop, never a database-resolved
value) is untouched, as is Phase 5's bot classification/routing pipeline.
Phase 6's new domain-usability checks happen at *configuration* time (API)
as an additional, earlier gate — the tracker's own defense-in-depth checks
at *request* time are unchanged and still the actual enforcement for
traffic that somehow gets past them (e.g. a domain deactivated after a
campaign was already configured against it).

The existing regression suites for these paths
(`apps/tracker/test/tracker.routes.test.ts`,
`apps/tracker/src/modules/**/*.test.ts` — 138 tests as of Phase 5) were
run unmodified as part of Phase 6's verification and continue to pass,
since no tracker code changed.

## Data model changes

**None.** `CampaignStatus` (`DRAFT`/`ACTIVE`/`PAUSED`/`ARCHIVED`) and
`TrackingLinkStatus` (`ACTIVE`/`PAUSED`/`ARCHIVED`) already had exactly
the values Phase 6's lifecycles need — the gap was that nothing validated
*transitions* between them, not that a value was missing. No migration
was required.

## Known limitations

- **Campaign status does not gate traffic**, by design (see "Interaction
  with the campaign lifecycle" above) — pausing a campaign does not pause
  its tracking links. An operator who wants to actually stop traffic must
  pause the links (or the domain) directly. A future phase could add an
  explicit "pause campaign also pauses its links" cascade, or wire
  `Campaign.status` into `TrackingResolver`, but either is a tracker-facing
  change deliberately deferred out of this control-plane-only phase.
- **`Destination.isActive` is not checked at assignment time** — only
  organization ownership and URL validity (already enforced at creation)
  gate a `destinationId` reference. Unlike `TrackingDomain`, an inactive
  `Destination` doesn't cause the tracker to reject a request (Phase 3's
  transparent redirect doesn't read `TrackingLink.destinationId` at all —
  it's administrative/informational), so there was no equivalent
  "guaranteed dead on arrival" failure to close here.
- **No bulk operations** — activating/pausing/archiving multiple campaigns
  or tracking links at once requires one API call per resource. Not
  requested in scope, and the single-resource endpoints are the safer
  building block for a future bulk action to compose from.
- **The dashboard's transition-button availability is a manually
  maintained mirror** of the backend state machine (see "Dashboard
  changes" above) — a future refactor could generate it from a shared
  source, but the backend is the actual enforcement point either way.
- Conversion tracking, the affiliate/partner system, the attribution
  engine, the Rules & Routing Engine (Phase 8), ML-based bot detection,
  external bot intelligence, and any Google Transparent Click Tracker
  certification claim remain out of scope, unchanged from Phase 1-5.
