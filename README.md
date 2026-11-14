# Memberships

Common Ground is a gym, studio, club or community membership app. One Next.js app, Postgres rows and server-owned access.

Use Node 24.18.0 and pnpm 11.15.1. Run `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`, set DATABASE_URL, SESSION_SECRET (at least 32 characters), APP_ORIGIN and PRAMAAN_PROJECT_ID, then `pnpm db:migrate`, `CIRCLE_NODE_TOTAL=2 NODE_OPTIONS=--max-old-space-size=768 pnpm build`, and `pnpm start --port 3510`. For local HTTP only, APP_COOKIE_SECURE=false. Production needs secure cookies.

Owners enter through the platform owner pass. Members sign up publicly. The owner adds staff with a temporary password shared privately. Use the plans page to join and the front desk to check members in.

Email and billing are off locally. Billing uses only the platform capability door in lib/pramaan.ts; email uses lib/email.ts. The platform, not this app, holds PRAMAAN_API_KEY and payment account credentials. Connect a test payment account and set PRAMAAN_PAYMENTS_TEST_MODE=true to enable test billing. The flag alone cannot turn a live account into a test account. Recurring joins create a plan and use billing.subscription.create in authorize form; the member follows its returned first-payment authorization link. Access starts only after billing.subscription.get reads active. Real-account compatibility is a deployment check in GAPS.md. Test-only fixture code never runs inside an app route.

Tests need migrated disposable TEST_DATABASE_URL. Run `pnpm test`; `pnpm walk` checks the headless journeys with a fake billing/email door. Do not point tests or the walk at customer data. See KIT.md and GAPS.md.

## Built on

MIT data starter from Pramaan-Dev/product-loop at the commit pinned in pramaan.kit.json, with account and HTTP helper copies from the portal reference kit. Uses MIT Pramaan-OSS/blocks patterns pinned in blocks.lock.json. Copyright (c) 2026 Sudo Sapient. See NOTICE.md and LICENSE.
