# Property Tour API

Cloudflare Worker + Hono API, D1 metadata, and private R2 objects. Architecture follows `docs/03-BACKEND-WORLDLABS.md` and the product boundary/limits in docs 04 and 10. This backend never executes FFmpeg and contains no World Labs request client: a separately deployed processor implements the contract below. No provider calls are made by this project/tests.

## Local/deploy setup

Use Node 22+, install with `npm install`, then create a local D1 database and private R2 bucket. Set the real D1 id and bucket name in `wrangler.toml` before remote deployment; apply `wrangler d1 migrations apply property-tour --local` and later `--remote` after creating the resources. Build `../web` before starting or deploying this Worker: its static assets binding serves the interactive application, while `/t/:slug` includes an immediate poster in HTML. Configure Access by setting `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, with `AUTH_MODE="access"` (default). JWT signature, issuer, audience, and subject/email are verified against the Access JWKS. For loopback-only development, create untracked `.dev.vars` with a freshly generated high-entropy `PROCESSOR_SECRET` and start `npm run dev -- --ip 127.0.0.1 --port 8787 --var AUTH_MODE:local`. Vite adds the same secret as `X-Local-Dev-Key` through its server-side proxy. Local mode must never be enabled in deployment. Internal processor routes always require `Authorization: Bearer <PROCESSOR_SECRET>`.

`MEDIA` is private. Browser upload is Worker-proxied streaming multipart; part size defaults to 8 MiB and is constrained to 5–10 MiB. Configure `MAX_UPLOAD_BYTES` (default 1 GiB). `POST /uploads` receives metadata only and creates a resumable R2 multipart upload. Each PUT streams the raw request body into one R2 part, without buffering the whole video. The last part may be smaller. Upload completion requires every part in order with matching R2 ETags.

## Browser API

All studio routes require verified Cloudflare Access JWT; local mode is only loopback-bound. The JSON response shapes match the requested frontend contract: `GET /api/tours` -> `{tours}`, create/get/status/approve/publish -> `{tour}` (get also has `scene`, status also `job`). Upload start -> `{uploadId,partSize}`, part PUT -> `{etag}`, completion -> `{tour}`. Public `GET /api/public/tours/:slug` returns the minimum tour metadata and scene URLs. `GET /t/:slug` is a poster-first HTML fallback. Asset URLs resolve only for the active approved version of a published tour; all generated objects remain private in R2 and are streamed by the Worker after the publish gate.

## Processor contract (matches `app/processor/src/cli.ts`)

All calls use `Authorization: Bearer <PROCESSOR_SECRET>` over TLS outside localhost.

1. `POST /api/internal/jobs/claim` (no body) atomically claims one queued job; response is `{job:{id,tourId,uploadKey,sourceBytes,title}}` or `{job:null}`. Claims are serialized in D1 and **never automatically reclaimed**, even after the recorded lease deadline: the processor may still be preparing a paid request. A stalled claim requires operator reconciliation. The processor currently has no worker identity token, so the shared secret is its authentication boundary.
2. `GET /api/internal/media/:key` streams the source object. `uploadKey` is an opaque upload ID, not an R2 path; source keys are only resolved through completed upload/job records.
3. `POST /api/internal/jobs/:id/events` accepts processor phases `validating`, `uploaded`, `start_uncertain`, `generating`, `collecting`, `ready_for_review`, `failed`, plus event details. It rejects invalid transitions. `start_uncertain` is persisted before generation; jobs in uncertain/generating states are never reclaimed for a duplicate paid POST.
4. `POST /api/internal/jobs/:id/assets?name=...` accepts poster WebP/JPEG/PNG, panorama JPEG/PNG, and 100k/500k SPZ with matching content types. Each stream is written into a versioned private key allocated on claim and recorded in `job_assets`; retries overwrite the same private staged key.
5. `ready_for_review` must include `worldId`, `durationSeconds`, prepared input `bytes`, `cost`, `spatial`, and asset metadata `{name,file,bytes,contentType}`. The API verifies positive duration ≤30 seconds and provider input ≤100,000,000 bytes, staged asset sizes/types, a poster, and the 100k SPZ. Optional panorama and 500k SPZ are accepted. Cost is retained as JSON. Rejected completion leaves staged data private.

The processor’s own media contract is authoritative for input validation: complete clip only; MP4/MOV/WebM (with supported video codec); max 30 seconds; max 100,000,000 bytes submitted to provider. Oversized originals may be whole-clip transcoded by the separate processor; the Worker never executes FFmpeg or submits provider requests. Never blindly retry an ambiguous paid generation POST; reconcile by operation ID using GET.

The active published scene pointer is not changed when a replacement job is claimed, staged, completed, or approved. Approval marks the pending version only. Publish switches the pointer. The old public version remains live through replacement processing/review; pending/private objects cannot be fetched through public routes.

## Local private demo import

With local auth enabled, POST raw video bytes to `/api/local/demo-import` with `Content-Length`, `Content-Type`, and optional `X-Tour-Title` / `X-Room-Name`. It creates a private R2 source, draft-processing tour, and idempotent processor job. It does not call World Labs and is disabled (404) unless `AUTH_MODE=local`. The imported demo remains private until processor validation, operator approval, and explicit publication.

To inspect **existing outputs without creating a processor job**, use the local-only `/api/local/demo-scene` create/upload/complete endpoints described in `../README.md`. The resulting `/studio/demo/:tourId` scene and optional `/api/tours/:id/source` video stream remain owner-authenticated. Browser video seeking uses HTTP Range responses.

## States and schema

Migrations define users, tours, uploads, multipart parts, generation jobs/leases, and immutable scene versions. Tour states follow draft/uploading/preparing/generating/collecting/ready_for_review/approved/published, or failed. Publication switches the active version pointer only after explicit review approval. Existing public versions remain immutable and old asset URLs stay versioned; a newer active version does not overwrite bytes. The current schema binds one active scene version per tour.

## Limitations / integration assumptions

- Access identity uses `sub` as the stable user ID; the initial user row gets a non-delivery placeholder email because provisioning/roles are not defined here.
- Worker processor output keys are versioned/private, but asset ingestion and D1 result writes should be restricted to the processor identity. R2 bucket binding/credentials are provisioned outside this folder.
- Browser-to-Worker traffic incurs Worker bandwidth; this implementation streams to R2 without full-file memory buffering. Direct browser-to-R2 multipart signing can be introduced later if transfer cost warrants it.
- World Labs' current video prompt guidelines specify 30 seconds and 100 decimal MB, with MP4/MOV/WebM formats.
- `../web/dist` must be built before the Worker is deployed. Do not apply a Cloudflare Access policy to public `/t/*` and `/api/public/*` paths; operator API and studio paths require Access.

Run `npm test` and `npm run typecheck` for local verification.
