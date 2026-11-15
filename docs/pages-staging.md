# Capture staging on Cloudflare Pages

Project: `roova-capture-stage`. The preview is deployed at the stable **preview-branch alias** `https://staging.roova-capture-stage.pages.dev`. Use the alias rather than an immutable deployment-hash URL; IndexedDB is scoped to the exact origin and browser profile.

## Provisioned staging-only resources

- D1: `roova-capture-stage-db` (migrations `0001_init.sql` and `0002_processor_contract.sql` applied remotely).
- Private R2: `roova-capture-stage-media` (required by the existing API binding; room captures stay in the phone's IndexedDB).
- Pages configuration: `app/web/wrangler.toml`, `AUTH_MODE=access`. The team domain and audience correspond to the `roova-capture-stage-preview` Access application. Never use `AUTH_MODE=local` on a public hostname.

## Access prerequisite

The `cf` CLI created `roova-capture-stage-preview`, a self-hosted Access application protecting `*.roova-capture-stage.pages.dev` (including the `staging.` alias and immutable preview URLs). The only allow policy is `roova-capture-stage-email-only`, which includes the connected Cloudflare-account email. An anonymous request to `/studio` was verified to redirect to Access (302). The project root `roova-capture-stage.pages.dev` is **not** protected by this wildcard; do not deploy the main/production branch for this test.

The protected preview was redeployed with `AUTH_MODE=access` and the matching AUD and team domain. Anonymous requests to `/studio`, `/api/tours`, and the JavaScript assets each returned an Access redirect (302). Authentication and camera/motion capture on physical phones are still awaiting device verification.

The application's **Application Audience (AUD) tag** and Access **team domain** (`https://<team>.cloudflareaccess.com`) are in `app/web/wrangler.toml`. These are identifiers, not bearer secrets. The API verifies Access's signature, issuer, audience, and subject before reading or creating tours.

## Build and deploy

```powershell
cd app/api
npm ci
npm test
npm run typecheck
cd ../web
npm ci
npm test
npm run build:pages
..\api\node_modules\.bin\wrangler.cmd pages deploy dist --project-name roova-capture-stage --branch staging
```

`build:pages` compiles the existing Hono Worker into Pages Advanced Mode's `dist/_worker.js`. That adapter routes `/api/*`, `/studio*`, and `/t/*` to Hono and delegates static assets to `env.ASSETS`. No API key is bundled in the frontend. The app's existing `/studio` route serves the shell on reload.

## Phone acceptance

1. On each phone, open **exactly** `https://staging.roova-capture-stage.pages.dev/studio` in Safari (iOS) or Chrome (Android), authenticate with Access, and create a draft tour with a room name.
2. Select the tour, open capture, allow rear camera and motion, align with any target, and hold for one second. Check target number, preview, measured yaw/pitch/roll, timestamp, and pixel dimensions.
3. Reload on the same browser and hostname. The frame and captured marker must return. Record phone model, OS/browser versions, output dimensions, and any failed stage in `docs/capture-checks.md`.
4. A different phone/browser/origin has different local frames; no images are uploaded by slice 1. Physical-device results are required before declaring slice 1 complete.
