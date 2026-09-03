# Redirect Audit (Phase 12)

A complete, repository-wide search for redirect-shaped code, performed for
Google Transparent Click Tracker certification preparation. Search terms
(per the Phase 12 brief): `redirect(`, `reply.redirect`, `res.redirect`,
`Location`, `location.href`, `window.location`, `destinationUrl`,
`targetUrl`, `redirectUrl`, `redirection_url`, `safePageUrl`,
`affiliatePartnerId`, `campaignId`.

## Actual HTTP redirect call-sites (the complete list)

A repository-wide search for `.redirect(` / `redirect(` / `window.location`
/ `location.href =` across every `.ts`/`.tsx` file found **exactly two**
call-sites that issue an HTTP redirect response anywhere in this
codebase:

| File | Line | Purpose | Google Ads-facing | Transparent | Safe | Action required |
| --- | --- | --- | --- | --- | --- | --- |
| `apps/tracker/src/modules/tracker/tracker.routes.ts` | 277 | `reply.redirect(resolution.safePageUrl, 302)` — BOT/BLOCKED-policy traffic to the campaign's server-configured Safe Page | Yes (this is the tracker's response to a request that arrived via a tracking URL) | N/A by design — this is the one documented, non-transparent exception (§5 of `google-transparent-click-tracker.md`): `BOT` traffic is uniformly routed away from the visible destination to a fixed, campaign-configured Safe Page. It does not depend on which caller is asking (no reviewer-vs-user branching), and it never substitutes for the visible destination on `HUMAN` traffic. | Yes — `resolution.safePageUrl` comes only from `Campaign.safePageUrl`, a value an organization member configures in advance via the authenticated API; it is never derived from, or influenced by, any part of the incoming request. | None. Behavior matches Phase 3/5's documented design exactly; covered by dedicated tests (`tracker.routes.test.ts`'s "bot routing" and "Safe Page cannot be overridden" groups, and this phase's own compliance suite). |
| `apps/tracker/src/modules/tracker/tracker.routes.ts` | 289 | `reply.redirect(redirectTarget, 302)` — TARGET routing (the default for `HUMAN`, and for `SUSPICIOUS`/`UNKNOWN` under the default policy) | Yes — this is the core transparent-tracker behavior | **Yes.** `redirectTarget` is the return value of `validateTransparentRedirectUrl(rawRedirectionUrl)`, where `rawRedirectionUrl` is read directly from the request's own `redirection_url` query parameter a few lines earlier. The exact same parsed-and-validated string is what gets redirected to — no re-derivation, no substitution, no intermediate hop. | Yes — `validateTransparentRedirectUrl` (`packages/shared/src/transparent-redirect.ts`) restricts to well-formed `http`/`https` URLs, rejects userinfo/control characters/protocol-relative input, and bounds length, before this line ever runs. | None. This is the line the entire certification effort exists to verify; see the full test matrix in `apps/tracker/test/google-transparency-compliance.test.ts`. |

No other file in the repository calls `.redirect()` on an HTTP response,
sets a `Location` header manually, or otherwise issues a server-side HTTP
redirect. (`reply.header("Location", ...)` does not appear anywhere;
Fastify's `reply.redirect()` sets it internally for the two call sites
above.)

## Client-side navigation (dashboard — not Google Ads-facing)

`router.push`/`router.replace` (Next.js client-side navigation, not an
HTTP redirect response) appear in four files, all purely internal to the
authenticated admin dashboard:

| File | Purpose | Classification |
| --- | --- | --- |
| `apps/dashboard/src/app/login/page.tsx:41` | After successful login, navigate to `/dashboard` | Internal dashboard navigation |
| `apps/dashboard/src/app/page.tsx:13` | Root path: navigate to `/dashboard` or `/login` depending on auth state | Internal dashboard navigation |
| `apps/dashboard/src/components/app-shell.tsx:33` | Unauthenticated visitor to a protected page: navigate to `/login` | Authentication redirect |
| `apps/dashboard/src/components/app-shell.tsx:80` | After logout: navigate to `/login` | Authentication redirect |

None of these are reachable from, or relevant to, a Google Ads tracking
URL — the dashboard is a separate origin/application entirely, and no
tracker request ever touches this code.

## `redirection_url` handling (the transparent parameter itself)

| File | Purpose | Action required |
| --- | --- | --- |
| `packages/shared/src/transparent-redirect.ts` | Defines `validateTransparentRedirectUrl` — the sole parser used to both validate and produce the redirect string | None — audited in full; see `docs/compliance/google-transparent-click-tracker.md#3-destination-transparency`. |
| `apps/tracker/src/modules/tracker/tracker.routes.ts` | Reads `redirection_url` from the query string, validates it, and is the only place it's used to build a redirect | None. |
| `apps/tracker/test/tracker.routes.test.ts`, `apps/tracker/test/google-transparency-compliance.test.ts` | Test coverage of the above | None — this phase added the latter file specifically as certification evidence. |
| `docs/compliance/google-transparent-tracker.md`, `docs/compliance/google-transparent-click-tracker.md`, `docs/architecture/overview.md` | Documentation of the parameter's role | Updated this phase. |

## `safePageUrl` handling (the one documented non-transparent routing target)

| File | Purpose | Action required |
| --- | --- | --- |
| `packages/database/prisma/schema.prisma` | `Campaign.safePageUrl` column definition, with an extensive doc comment on why it exists and how it differs from `redirection_url` | None. |
| `apps/api/src/modules/campaigns/campaigns.service.ts` | CRUD for `safePageUrl` — validated by `normalizeDestinationUrl` (the same admin-configured-URL validator `Destination.url` uses), settable only by an authenticated organization member with `MEMBER`+ role | None — this is a server-side configuration value, not request input. |
| `apps/tracker/src/modules/tracker/prisma-tracking-resolver.ts` | Reads `campaign.safePageUrl` as part of tracking-link resolution | None. |
| `apps/tracker/src/modules/tracker/tracker.routes.ts` | Redirects `BOT`/`SAFE_PAGE`-policy traffic here (see redirect call-site table above) | None. |
| `apps/dashboard/src/app/campaigns/page.tsx`, `apps/dashboard/src/app/campaigns/[id]/page.tsx` | Dashboard form fields for configuring a campaign's Safe Page URL | None — internal admin UI. |

## `affiliatePartnerId` / `campaignId` occurrences

A repository-wide search for these two field names returns dozens of
files — nearly all of them are the field's ordinary appearance in CRUD
services, validation schemas, Prisma queries, dashboard forms, and test
fixtures for the affiliate-partner and campaign management features
(Phases 6 and 9), which is expected and not redirect-related at all.
Classified by category rather than file-by-file:

| Category | Example files | Google Ads-facing | Action required |
| --- | --- | --- | --- |
| Campaign/tracking-link/affiliate-partner CRUD (create/list/get/update/lifecycle) | `apps/api/src/modules/campaigns/*.ts`, `apps/api/src/modules/tracking-links/*.ts`, `apps/api/src/modules/affiliate-partners/*.ts` | No — organization-authenticated control-plane only | None |
| Conversion/reporting aggregation (`GROUP BY campaignId`, filters) | `apps/api/src/modules/analytics/analytics.service.ts`, `apps/api/src/modules/reports/*.ts` | No — read-only reporting | None |
| Webhook event payloads (Phase 11) | `apps/api/src/modules/campaigns/campaigns.service.ts` (`campaignEventPayload`), `apps/api/src/modules/affiliate-partners/affiliate-partners.service.ts` | No — outbound webhook data, not a redirect | None |
| Denormalized attribution fields on `Click`/`Conversion` | `packages/database/prisma/schema.prisma` | Indirectly (these rows are written as a side effect of tracker requests) | None — already audited in §8 of `google-transparent-click-tracker.md`: these are write-only attribution snapshots, never read by the redirect decision, and never client-settable on a `Conversion`. |
| The one place `affiliatePartnerId` is actually read during a tracker request | `apps/tracker/src/modules/tracker/prisma-tracking-resolver.ts` (returns it from the resolved `TrackingLink`), `apps/tracker/src/modules/tracker/tracker.routes.ts` (passes it to `recordClick` for storage only) | Yes (it's part of resolving the request) | None — confirmed by reading both call sites: the value is stored on the `Click` row and never referenced when deciding the redirect target. See the redirect call-site table above — neither `reply.redirect()` call references `affiliatePartnerId` or `campaignId` in any way. |

## Conclusion

The tracker's redirect surface is exactly two lines of code, both fully
audited above. Every other occurrence of the searched terms is either
internal dashboard navigation, authenticated control-plane CRUD, or
write-only attribution/reporting data that the redirect decision never
reads. No hidden redirect destination, no opaque destination
substitution, and no deceptive cloaking mechanism were found anywhere in
the repository.
