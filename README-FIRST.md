# Property Tour Platform — Local Handoff

**Handoff date:** 13 November 2026  
**Status:** Live World Labs reconstruction succeeded; application implementation in progress.  
**Start here:** `RESUME-PROMPT.md`, then `docs/01-PRODUCT-AND-DECISIONS.md` and `docs/07-CURRENT-STATUS-AND-ACCEPTANCE.md`.

## What this package contains

- `docs/`: product scope, decisions, conversation timeline, backend design, video-size strategy, mobile UX/performance, research sources, open work.
- `code/property-tour-worldlabs-m1/`: **real runnable TypeScript integration harness**, including tests, compiled JS and instructions.
- `original-artifacts/property-tour-worldlabs-m1.zip`: original delivered source archive, unchanged.
- `design/property-tour-mobile-prototype.html`: clickable interface prototype; uses illustrative artwork, not a working 3D renderer.
- `design/property-tour-mobile-ux-spec.md`: detailed initial UX specification.
- `local-tools/video-prep.mjs`: new, local-only FFmpeg preparation helper with a JSON report.
- `app/web/`: mobile-first visitor and operator React interface with lazy Spark 3D viewing.
- `app/api/`: Cloudflare Worker/Hono API, D1 schema, private R2 asset and upload routes.
- `app/processor/`: Node/FFmpeg processing worker and private World Labs client.
- `samples/`: small **previously uploaded test footage** and contact sheets; none is a verified final-quality benchmark.
- `MANIFEST.sha256`: file-level integrity hashes (not included in its own hash list).

**Live test assets:** The successful private test is stored in `code/property-tour-worldlabs-m1/.runs/full-room-29s-attempt-3/`. Its 29.7-second input is `video/reconstruction-full-29s-test.mp4`; it contains the whole original recording at approximately 2.07× speed. The source recording is local to the user's computer. API credentials, a public tour, and a deployed production backend are not included.

## Quick start on Windows (PowerShell)

Extract ZIP, open PowerShell in this folder, and inspect your video:

```powershell
node .\local-tools\video-prep.mjs --input "C:\Videos\your-dl3dv-video.mp4" --inspect
```

**For the one-off research dataset test only**, select a continuous interval manually (example starts at 15 seconds). Product users will never perform this step:

```powershell
node .\local-tools\video-prep.mjs --input "C:\Videos\your-dl3dv-video.mp4" --prepare --start 15 --duration 25 --output ".\prepared\room-marble.mp4"
```

Requires Node.js 20+, FFmpeg and FFprobe installed locally. This helper is for **developer research only** because the DL3DV raw dataset is not a finalized room clip. Production must never ask an operator to inspect a timeline, choose `--start`, or trim footage.

Run pre-existing mock tests:

```powershell
cd .\code\property-tour-worldlabs-m1
npm install
npm test
```

The package's baseline was verified: **8/8 mocked API tests passed**. Tests use mocked data and incur no World Labs charges.

Only when you are prepared for a paid live test, use the `README.md` in the integration folder. Do not commit an API key into the repository.

## Key principle

**Operator experience:** upload a **finished videographer-prepared clip** → automatic technical validation/compression of the full clip → generate room → approve result → publish stable URL. No trim selection, editing suite, keyframe tools, or mandatory AI chat in v1.

**Visitor experience:** show a high-quality poster immediately → visitor taps Explore → lazy-load 3D → progressive scene detail → reliable panorama/photo fallback. No login for visitors.

## Local-first development plan

1. Re-run mock tests and validate local preprocessing on the user-owned DL3DV video.
2. Run one **explicitly authorized** World Labs generation with the prepared clip.
3. Inspect assets and faithful visual reconstruction. Preserve source and provider metadata.
4. Benchmark 100k SPZ (and 500k if available) in Spark on actual Android/iPhone devices.
5. Implement and verify Cloudflare Workers/Hono + D1 + R2 and durable processing, now that the provider adapter has succeeded.
6. Serve a public tour only after operator approval; no runtime World Labs requests for visitors.

## Factual caution

DL3DV-10K is under CC BY-NC and separate dataset terms: obtain appropriate permission before commercial or public use. World Labs' live prompt guidelines specify a **30-second maximum** and the API specifies a 100 MB video input ceiling. The successful local test generated world `1bc10832-cefc-4206-b4b5-7464aadaae16` and charged 1,600 credits. Its fidelity has not been approved for publication.

## Latest product decision (supersedes earlier plans)

See `docs/10-VIDEO-EDITORIAL-BOUNDARY-ADR.md`: editing, segment choice, and trimming belong to the videographer. The platform does not offer those functions. Local benchmark preparation is a developer-only exception.
