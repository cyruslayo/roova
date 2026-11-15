# Stillroom application

The app has three components: `web/` (React visitor and operator UI), `api/` (Cloudflare Worker, D1 and private R2), and `processor/` (Node + FFmpeg + World Labs). The browser never receives the provider key. The processor is **not** needed to inspect the existing reconstruction.

## Review the existing scene locally (no paid API call)

1. Install dependencies in `web/` and `api/`; run `npm run build` in `web/`.
2. Apply the API migrations locally with `npx wrangler d1 migrations apply property-tour --local` from `api/`.
3. Create `api/.dev.vars` containing a generated high-entropy `PROCESSOR_SECRET=...`. Start `npm run dev -- --ip 127.0.0.1 --port 8787 --var AUTH_MODE:local` in `api/`.
4. In a second terminal, set `LOCAL_DEV_KEY` to the same local secret and start `npm run dev -- --host 127.0.0.1 --port 5173` in `web/`. The Vite proxy adds the secret server-side; it is never bundled into the browser.
5. To import an already-generated private scene, `POST /api/local/demo-scene` with `{ "title": "Room 29s Test", "roomName": "Living and dining room" }` and `X-Local-Dev-Key`. It returns `tourId` and `version`. Upload the four files under `code/property-tour-worldlabs-m1/.runs/full-room-29s-attempt-3/assets/` with `PUT /api/local/demo-scene/:tourId/assets/:filename?version=:version` (raw request body, appropriate image or octet-stream content type). `POST /api/local/demo-scene/:tourId/complete` with `{ "version": "...", "worldId": "1bc10832-cefc-4206-b4b5-7464aadaae16", "spatial": { "metricScaleFactor": 0.9532254338264465, "groundPlaneOffset": 1.4797840118408203 } }`. Optionally upload the 29.7-second source with `PUT /api/local/demo-scene/:tourId/source` as `video/mp4` for comparison.
6. Open `http://127.0.0.1:5173/studio/demo/:tourId`. Select **High detail · 500k** to inspect geometry alongside the source video. Assets remain private until you explicitly approve and publish.

The local-only import path is disabled in deployed Access mode. Do not run `app/processor` with `WLT_API_KEY` against a queued local test tour unless a new paid generation is explicitly intended.

## Deployment

`api/wrangler.toml` binds the built `web/dist` shell as static assets and routes `/t/:slug` through a poster-first HTML response. Provision a real D1 database and private R2 bucket, configure Cloudflare Access for studio/operator API routes, and set a private processor secret. Deploy a persistent FFmpeg-capable processor with a durable work directory; the D1 job queue deliberately never auto-reclaims a claimed job, since it may be past the paid POST. Recovery of a stalled claim or ambiguous paid start requires operator reconciliation. See each component README for commands and API contract.

This workspace has **not** been deployed or benchmarked on physical phones. The existing reconstructed room is a private fidelity-review fixture, not an approved public property listing.
