# Backend architecture and World Labs API contract

## Architecture (original proposal; local implementation differs)
One TypeScript application backend with Cloudflare Workers + Hono, D1 for state, R2 for original media and versioned output, Cloudflare Workflows for durable jobs, and CDN for published immutable assets. Public viewer uses small React shell and Three.js/Spark, not Toolcraft editor runtime. Private operator studio can reuse Toolcraft pieces as needed.

```
Operator browser ── direct upload ──> private R2
        │                              │
        └──> Workers/Hono API <──> D1  │
                       │               │
                       └─ Workflow <───┘
                            │ prepare/upload media
                            ├─ World Labs Marble (private generation)
                            ├─ poll operation until done
                            └─ copy scene outputs to versioned R2 paths
                                          │
Operator preview/approval ────────────────┘
                                          │
                         public manifest + poster + 3D assets via CDN
                                          │
                              Visitor's lightweight mobile viewer
```

### World Labs contract
Authoritative docs: https://docs.worldlabs.ai/api/reference/openapi . Pin or download the actual version when implementing. The existing M1 `src/contract.ts` is **curated**, not a full generated OpenAPI client.

- Authentication: `WLT-Api-Key` **only** on server-side calls to World Labs API origin.
- Media upload: `POST /marble/v1/media-assets:prepare_upload` -> `media_asset_id`, temporary upload method + URL + required headers. Never send WLT key to the signed upload URL.
- Generate: `POST /marble/v1/worlds:generate`, `model:"marble-1.1"`, `world_prompt:{type:"video",video_prompt:{source:"media_asset",media_asset_id}}`, `permission:{public:false}`.
- Track: `GET /marble/v1/operations/{operation_id}`. `done:true` is not synonymous with success; check `error` and `response`.
- Get output: `GET /marble/v1/worlds/{world_id}` -> optional `assets.thumbnail_url`, `assets.imagery.pano_url`, `assets.splats.spz_urls` map (may include 100k,500k,full_res) and scale/ground-plane metadata.
- Record settled credits from completed operation when present.
- Provider asset URLs should be downloaded and copied to our own storage before publication.

### Paid call safety
Record `start_uncertain` before making the paid generate request. Persist operation ID immediately after receipt. Never automatically repeat an ambiguous paid POST after a network timeout or crash. Reconcile with provider before another paid generation. Rate-limit new submissions account-wide. Resume and watch are GET-only.

### Suggested state machine
`draft -> uploading -> uploaded -> preparing -> start_uncertain -> generating -> collecting -> ready_for_review -> approved -> published`; failure state with an actionable reason at each step. M1 CLI has its own simplified versions of these states. Avoid fake percentage progress.

### Data records (future backend)
- `users(id,email,role)`
- `tours(id,owner_id,title,slug,active_scene_version,published_at)`
- `uploads(id,tour_id,r2_key,bytes,mime,status,sha256)`
- `generation_jobs(id,tour_id,model,media_asset_id,operation_id,world_id,status,credits_charged,attempt,provider_error,submitted_at,completed_at)`
- `scene_versions(id,tour_id,world_id,asset_manifest,scale_metadata,review_status,created_at)`

### Minimal HTTP endpoints (future)
- `POST /api/tours`
- `POST /api/tours/:id/uploads` (create authenticated upload)
- `POST /api/uploads/:id/complete` (verify object, launch job)
- `GET /api/tours/:id/status`
- `POST /api/tours/:id/approve`
- `POST /api/tours/:id/publish`
- `GET /api/public/tours/:slug` (minimal, cacheable scene manifest)
- `GET /t/:slug` (public visitor page)

### Publication rules
Operator reviews geometry against original footage. Publish atomically by changing the active `scene_version` pointer, without overwriting old CDN assets. Versioned assets cache long; manifest updates are short-lived or invalidated. Viewer must continue functioning when World Labs API is offline.

### Implementation status
The M1 harness successfully generated a private world from a 29.7-second clip; its output and charged credits are recorded under `.runs/full-room-29s-attempt-3/`. The local implementation in `app/` uses a Cloudflare Worker/D1/R2 and a separate Node/FFmpeg processor with D1 job claims; it does not currently use Cloudflare Workflows. A claimed job is not automatically reclaimed because the processor may be past the paid submission boundary. See `docs/07-CURRENT-STATUS-AND-ACCEPTANCE.md` for current application status. Nothing here implies a deployed Cloudflare application.
