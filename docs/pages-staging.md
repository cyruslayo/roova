# Capture staging on Cloudflare Pages

Project: `roova-capture-stage`. The preview is deployed at the stable **preview-branch alias** `https://staging.roova-capture-stage.pages.dev`. Use the alias rather than an immutable deployment-hash URL; IndexedDB is scoped to the exact origin and browser profile.

## Provisioned staging-only resources

- D1: `roova-capture-stage-db` (migrations `0001_init.sql`, `0002_processor_contract.sql`, and `0003_panorama_rooms.sql` applied remotely).
- Private R2: `roova-capture-stage-media` (required by the existing API binding; room captures stay in the phone's IndexedDB).
- Pages configuration: `app/web/wrangler.toml`, `AUTH_MODE=access`. The team domain and audience correspond to the `roova-capture-stage-preview` Access application. Never use `AUTH_MODE=local` on a public hostname.

## Access prerequisite

The `cf` CLI created `roova-capture-stage-preview`, a self-hosted Access application on `*.roova-capture-stage.pages.dev` (including the `staging.` alias and immutable preview URLs). The only allow policy is `roova-capture-stage-email-only`, which includes the connected Cloudflare-account email. Destination overrides make `/p/*`, `/t/*`, `/api/public/*`, and `/assets/*` publicly readable for published visitor tours. Studio and operator APIs remain Access-protected. The project root `roova-capture-stage.pages.dev` is **not** protected by this wildcard; do not deploy the main/production branch for this test.

The preview was redeployed with `AUTH_MODE=access` and the matching AUD and team domain. After the visitor overrides, anonymous requests to `/studio`, `/studio/panorama/example`, `/api/tours`, and `/api/rooms/example` returned Access redirects (302); `/assets/stitch-worker-DkwTBcug.js` returned 200, `/api/public/panoramas/not-found` returned 404, and `/p/not-found` served the shell (200). Authenticated end-to-end flow and camera/stitching on physical phones still await device verification.

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

`build:pages` compiles the existing Hono Worker into Pages Advanced Mode's `dist/_worker.js`. That adapter routes `/api/*`, `/studio*`, `/t/*`, and `/p/*` to Hono and delegates static assets to `env.ASSETS`. No API key is bundled in the frontend. The app's existing `/studio` route serves the shell on reload. Before deploying a build that requires rooms, apply `0003_panorama_rooms.sql` to the staging D1 database using `wrangler d1 migrations apply DB --remote` from `app/web`.

## Phone acceptance

1. On each phone, open **exactly** `https://staging.roova-capture-stage.pages.dev/studio` in Safari (iOS) or Chrome (Android), authenticate with Access, and create a draft tour with a room name.
2. Select the tour, open capture, allow rear camera and motion, align with any target, and hold for one second. Check target number, preview, measured yaw/pitch/roll, timestamp, and pixel dimensions.
3. Reload on the same browser and hostname. The frame and captured marker must return. Record phone model, OS/browser versions, output dimensions, and any failed stage in `docs/capture-checks.md`.
4. A different phone/browser/origin has different local frames; no images are uploaded by slice 1. Physical-device results are required before declaring slice 1 complete.

For the full-room build, after **37 / 37** choose **Create panorama**, check the on-device stitched viewer and **4096 × 2048** JPEG, reload, then explicitly choose **Upload finished panorama** and **Publish room**. Add a second room from Studio and check the ordered visitor view at `/p/<tour-slug>`. A failed stitch or upload must retain the original 37 JPEGs. Record the output dimensions and failed stage, not just whether a button was tapped.

## Media costs for the staging test

The finished JPEG and thumbnail use **R2 Standard** only after the user selects Upload. Cloudflare's [R2 pricing](https://developers.cloudflare.com/r2/pricing/) (updated 2026-10-30) lists 10 GB-month storage, 1 million Class A writes, and 10 million Class B reads per month in the Standard free tier; above that, storage is $0.015/GB-month, writes $4.50/million, and reads $0.36/million. R2 egress is free. One upload writes two objects; each visitor panorama/thumbnail read is a Class B operation. Older uploaded versions are retained during republishing, so storage increases until a separately authorized cleanup policy exists. D1/Pages request costs are separate and have not been measured for this test.
