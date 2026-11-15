# World Labs integration milestone (M1)

A runnable **contract-tested integration harness** for one property-room video.
It does **not** claim to be the production backend or publish a public URL yet.

## Requirements

- Node.js 22.12+ and TypeScript 5.8+ (available globally or via `npm install`)
- World Labs API key with funded credits, only for the live step
- A prepared 100 MB-or-smaller local video (MP4, MOV, WebM, AVI)

## Test without paying

```bash
npm install
npm test
```

The tests use mocked HTTP responses. They never contact World Labs.

## Run with a real property video

Set your key in the **terminal**, not in a browser or source file.

```bash
export WLT_API_KEY='your-api-key'
# Windows PowerShell: $env:WLT_API_KEY='your-api-key'
npm run cli -- submit --video /path/to/living-room.mp4 \
  --title "Living Room" --out .runs/living-room --confirm-paid
```

This command performs **one paid generation submission**. It records the `operation_id` in `.runs/living-room/state.json`.

To check and collect generated assets:

```bash
npm run cli -- resume --out .runs/living-room
# OR poll automatically without any new generation submission:
npm run cli -- watch --out .runs/living-room --interval 30
```

Once the provider finishes, the runner downloads the available `100k` and `500k` SPZ files, thumbnail, and panorama. It creates:

```text
.runs/living-room/
  state.json                      # private processing state
  latest-operation.json           # private provider operation, includes credits
  provider-world-private.json     # private provider URL metadata
  viewer-manifest.json            # staging manifest, NOT PUBLIC
  assets/
    poster.webp                    # if present
    panorama.jpg                   # if present
    100k.spz                       # if present
    500k.spz                       # if present
```

`viewer-manifest.json` references only local assets. Its `published` field stays false.

## Safety behavior

- Before the generate POST, the runner records `start_uncertain`.
- A response containing `operation_id` is saved immediately as `submitted`.
- If the paid request times out or the process crashes between acceptance and recording, the runner **refuses to submit again**. Investigate in the World Labs dashboard and reconcile first.
- `resume` and `watch` only use GET operations, so they cannot start a second paid generation.
- World Labs API credentials are never sent to the signed asset-upload URL.
- Source and provider output stay private. Approve visual accuracy before publishing.
- The current World Labs video prompt guidelines specify a 30-second maximum, and the API specifies a 100 MB maximum. This older harness validates file size but does not enforce duration; inspect and validate duration before a paid submission. The production processor in `../../app/processor/` enforces both limits.

## Boundaries

This milestone validates the external integration. It does **not** include Cloudflare Workers, Workflows, D1, R2, authentication, public URL publication, the actual Spark viewer, or device performance benchmarks. Those are the next vertical integration stages. Move the `WorldLabsClient` to the Cloudflare backend and the CLI storage logic to an R2 adapter after the real API response passes.

## OpenAPI contract

Reference: <https://docs.worldlabs.ai/api/reference/openapi>

The `src/contract.ts` types cover only the fields used by this harness. They are **curated against the reference**, not generated from a pinned full OpenAPI YAML.
Run `npm run spec:fetch` on a connected machine to obtain `openapi.yaml`, then generate/reconcile types in CI. The spec location must be verified before adoption; the docs page is the authoritative source.

## M1 acceptance evidence checklist

- [x] Mocked request/response contract tests pass locally
- [x] API credential separation tested
- [x] No automatic paid retry tested
- [x] SPZ manifest and spatial metadata tested
- [x] Real 29.7-second video uploaded to World Labs (`.runs/full-room-29s-attempt-3/`)
- [x] Real operation completed and 1,600 credits verified
- [x] Provider 100k/500k SPZ and poster/panorama downloaded
- [ ] Generated room reviewed against source video
- [ ] Android and iPhone Spark render benchmark
