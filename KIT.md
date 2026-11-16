# Memberships kit

## Where things live

- `app/page.tsx`: public plans and joining.
- `app/signin/page.tsx`: member signup and every role's sign-in.
- `app/membership/page.tsx`: own membership, payments and visits.
- `app/desk/page.tsx`: staff lookup and check-in; owner notes.
- `app/settings/page.tsx`: owner staff, plans, lists, CSV and email delivery.
- `app/owner/page.tsx`: owner credentials after the one-use owner pass.
- `app/api/account/[action]/route.ts`: starter authentication and owner pass.
- `app/api/health/route.ts`: starter health endpoint.
- `app/api/memberships/route.ts`: server-authorized reads, mutations and CSV downloads.
- `app/layout.tsx`: unchanged starter layout; `app/shell.tsx` supplies role-aware navigation.
- `app/parts.tsx`: shared forms, actions and money formatting.
- `app/theme.css`: bundled fonts and shared visual styling.
- `lib/accounts.ts`: unchanged portal accounts; server sessions and owner passes.
- `lib/runtime.ts`: shared database pool and public member signup.
- `lib/memberships.ts`: ownership checks, check-ins, durable billing operations, read-back and email outbox.
- `lib/csv.ts`: quoted CSV parser and spreadsheet formula protection.
- `lib/pramaan.ts`: single HTTP client for capabilities through the platform socket, never a browser key.
- `lib/email.ts`: platform email module client.
- `lib/roles/http.ts`: bounded same-origin JSON bodies and safe responses.
- `lib/pramaan/client.ts`: browser request and resource helpers.
- `src/db/migrations/0001`–`0004`: unchanged starter tables.
- `src/db/migrations/0100-memberships.sql`: normalized plans, categories, statuses, members, memberships, payments, check-ins, notes and email outbox. `0101` bounds retry windows; `0102` preserves checkout return links; `0103` adds the member phone required for payment authorization.
- `lib/memberships.pg.spec.ts`: server permission, isolation, payment and period-end regression checks against disposable Postgres.
- `scripts/migrate.mjs`: transactional numbered migrations.
- `scripts/fake-door.mjs`: local test-only billing and email door.
- `scripts/walk.mjs`: headless browser journeys with fake payments; never real billing.
- `scripts/check-contract.mjs`: product-loop contract, licence, secrets and package gates.

## Add a field

Add `0101-member-phone.sql` with an additive members column. Extend the scoped SELECT and owner mutation in `lib/memberships.ts` and `app/api/memberships/route.ts`, add the form to the owner view, and test that another member cannot read or change it. Do not accept membership status, billing references or prices from member input.

## Add a page

Add `app/example/page.tsx` and a nearby `pramaan.feature.json` describing its route and audience. Add the navigation link, manifest entry point and a checklist. Read data only from a route that calls `requireUser` and the appropriate server role guard; hidden navigation does not enforce permissions.

## Add a role

Store roles in `app_users.role`. Only the owner can grant privileged roles on the server. Public signup always creates member. Use the starter `requireRole` or the kit's owner/desk checks after `requireUser`; scope member reads through user_id. Staff cannot see payments or private notes and cannot manage memberships.

## Journeys that ship working

- `public-plans`: browse plans without a session.
- `member-signup`: a visitor signs up in their own browser and sees their own membership page.
- `owner-settings`: owner pass and owner credentials.
- `front-desk`: owner/staff lookup screen; the headless walk additionally checks an active member in and refuses access after period end.
- `edit-lists`: owner editable seeded statuses and plan categories. Values in use cannot be deleted; billing's required states can be renamed but not removed.

`join-and-pay` waits for payments to be switched on (needs-capability); its checklist keeps the sign-up steps so it runs once they are. The headless walk proves recurring join with the fake door: the server creates a saved billing plan, sends the authorize form of billing.subscription.create with the member's contact details, saves its authorization link, and activates only when billing.subscription.get confirms active. No browser result grants access. Real-account compatibility is recorded in GAPS.md and no live calls are made. Pause/cancel and email modules remain needs-capability when off. Full kit CI: runs in product-loop on pinning; leave the local red record unchanged.
