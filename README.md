# AdstrackIO frontend

The current preview uses Vite and TypeScript, with the existing CUBA-inspired campaign design. Publisher pages reuse the same sidebar, header, icons, tokens and card/control conventions; they do not introduce a second framework or backend.

## Development

```sh
npm install
npm run dev -- --host 127.0.0.1
```

Use the local URL printed by Vite. The existing development environment uses port 5173.

## Publisher routes

- `/publishers` — searchable demo directory with status filtering.
- `/publishers/create` — create a publisher preview.
- `/publishers/101` — demo publisher information.
- `/publishers/101/edit` — edit the same record using the shared PublisherForm.
- `/publishers/postbacks` — clearly labeled, unconnected postback/pixel placeholder.

Unknown publisher IDs show a not-found state. Publisher names open details; Edit actions open the edit route.

`src/app-shell.ts` owns the shared Campaign/Publisher navigation and header. `src/publisher-form.ts` contains PublisherForm and its reusable information, address, account, advanced setup, notification, summary, activity and settings components. Route mounting and the small directory/details views live in `src/publisher-pages.ts`.

## Preview data boundary

`src/publisher-data.ts` isolates the typed publisher model, country/status choices, validation, fictional fixtures (#101 and #102), and local preview storage. Create and edit saves use **sessionStorage in the current browser tab only**, under `adstrackio:publisher-preview:v1`. New preview IDs start at 103. Saves report browser storage failures. Replace these exported data functions with an API adapter when integration is available.

No live account, tracking, payout, password, invitation, or access changes are made. SMTP is not configured, so email notification remains disabled. The advanced configuration controls save preview preferences only; hidden advanced fields are not validated. The activity card explicitly shows static demo events.

## Advertiser routes

- `/advertisers` — searchable directory with account-status filtering.
- `/advertisers/create` — create an advertiser preview.
- `/advertisers/25` — demo advertiser information.
- `/advertisers/25/edit` — edit using the same AdvertiserForm as Create.
- `/advertisers/postbacks` — unconnected PostBack / Hits view, linked to the demo configuration card.

`src/advertiser-form.ts` provides AdvertiserForm, AdvertiserBasicInfo, AdvertiserBusinessInfo, AdvertiserBillingInfo, AdvertiserAdvancedSetup, AdvertiserPostback, AdvertiserNotificationSettings, AdvertiserSummary, AdvertiserActivity and AdvertiserSettings. Publisher and Advertiser fields share `src/account-form-controls.ts`, existing Publisher card/control styles, and the common AppShell. No framework or backend was added.

Advertiser data lives under `adstrackio:advertiser-preview:v1`, independent from Publisher storage. Fictional fixtures use IDs 25 and 26; new local IDs start at 27. PostBack Security Tokens explicitly say `DEMO_ONLY`, and generated sample URLs use `tracking.example.invalid`. They are placeholders, not provisioned credentials or endpoints. Copy uses the clipboard; Debug Postback performs only local URL/configuration checks and sends no requests. Validation text remains plain text and Global Pixel choices do not execute code.

Billing fields, Notes, manager references, and advanced preferences are saved locally. SMTP, real token regeneration, API key generation, account suspension/deletion, and invitations remain unavailable.

## Checks

```sh
npx tsc --noEmit
node --test tests/publisher-data.test.ts
node --test tests/advertiser-data.test.ts
npm run build
```

The test command uses native TypeScript support in Node.js; this workspace uses Node 26. No lint script or linter is configured in this project.
