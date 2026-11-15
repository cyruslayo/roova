# Stillroom web app

Vite + React + TypeScript frontend for the visitor tour (`/t/:slug`) and operator studio (`/studio`). The visitor poster is rendered before the renderer is requested; Spark and Three.js are dynamically imported only after **Explore in 3D**. The operator supports tour creation, multipart uploads, status refresh, private scene review, approval, and publication through the API contract.

## Run locally

Requires Node.js 20+.

```sh
npm install
npm run dev
```

Vite proxies `/api` to `http://localhost:8787` by default. Set `VITE_API_PROXY=http://localhost:<port>` when starting the dev server if the API uses another local port. For a deployed API origin, set `VITE_API_BASE=https://api.example.com` at build time. Studio authentication is expected from deployment-provided Cloudflare Access headers.

For the API's loopback-only `AUTH_MODE=local`, set `LOCAL_DEV_KEY` in the shell that launches Vite. Vite adds it as `X-Local-Dev-Key` to proxied API requests on the server; it is not a `VITE_*` variable and is never included in frontend bundles. PowerShell example:

```powershell
$env:LOCAL_DEV_KEY = '<same local PROCESSOR_SECRET configured for the API>'
$env:VITE_API_PROXY = 'http://localhost:8787'
npm run dev
```

Do not set `LOCAL_DEV_KEY` for a deployed frontend.

## Routes

- `/t/:slug` — anonymous visitor experience.
- `/studio` — tour list and operator workflow.
- `/studio/demo/:tourId` or `/studio/demo?id=<tourId>` — authenticated private review route. It calls `GET /api/tours/:id` and uses the returned review `scene` URLs; private staging assets must be served by the API only to the owning operator. It never requests unpublished assets from the public-tour endpoint.
- `/studio/demo?slug=<published-slug>` — public visitor preview for an already published tour; defaults to `demo`.
- `/studio/capture/:tourId` — authenticated room capture session for the selected tour's room. Camera and motion are requested from separate tap actions; JPEG source frames and pose are saved in this browser's IndexedDB under the tour ID. Reopening the URL restores the captured frame and marker. No frame is uploaded or stitched from this page.

## Build and checks

```sh
npm run build
npm test
```

For phone testing on the protected Cloudflare Pages preview, see `../../docs/pages-staging.md`. `npm run build:pages` builds the Vite shell and the same-origin API adapter into Pages Advanced Mode output; the standard `npm run build` continues to build only the web shell.

The private review route uses operator-authorized poster/panorama/SPZ URLs and can play the original source video. It offers 100k and 500k scene inspection without publishing. See `../README.md` for importing the existing reconstruction locally. Tour state is read from `tour.state`; job state from `job.state`. An unavailable public tour does not show an unrelated property image. Multipart upload checkpoints are stored locally and revalidated with the API when the same file is selected after a reload; interrupted-part recovery was exercised in local Chromium. Physical-device rendering and deployment Access policies remain unverified.
