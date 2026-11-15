# Video file-size strategy: technical processing only, no editorial selection

## Triggering example
The user downloaded an original DL3DV video of approximately **390 MB**. World Labs documents a **100 MB** upper bound for video input and its live prompt guidelines specify **30 seconds maximum**. A research dataset may contain long, unedited footage. That is **not** a customer-ready deliverable. Asking a developer to use FFmpeg for an internal experiment is acceptable, but NOT part of customer onboarding.

## Product UX: one file, automatic processing

1. Operator selects prepared recording. Immediately inspect *local* lightweight metadata, show size and whether optimization will be needed. Do not upload just to learn extension/size.
2. If already within provider constraints and capture quality acceptable, take the fast path.
3. If larger, offer reliable **resumable transfer** to private R2. Show actual bytes and recovery, not invented progress.
4. On the backend, inspect with FFprobe. Check container, codec, duration, dimensions, decode integrity, and obvious quality defects. Do **not** edit or select content.
5. If the recording is too long, has cuts, or has insufficient room coverage, reject it with a clear explanation for the **videographer** to prepare a finished clip. **No automatic segment selection or trim control** in the product.
6. If duration/coverage are acceptable but byte size exceeds the provider limit, transcode the **entire** supplied clip to a compatible H.264 MP4, preserving playback duration and chronological content. Validate output fidelity; do not upscale or speed up footage.
7. Submit the compatible file to World Labs via managed media upload. Keep the source in private R2 for a defined retention period.
8. After generation, show the reconstruction for operator approval. Delete unnecessary intermediate transcodes under the retention policy.

## The upload bottleneck is distinct from the API bottleneck
Server-side transcoding solves **World Labs' 100 MB limit**, but not the time to upload a 390 MB source. The network still carries 390 MB. For initial web v1, reliability is more important than universally promising browser transcoding. Measure 4G experience; add optional desktop-side optimization only after testing device memory, battery, and browser support. WebCodecs/FFmpeg-WASM is not universally safe for long 4K videos on mobile.

Cloudflare R2 documented options:
- Single PUT: good for smaller uploads, non-resumable.
- Multipart: intended for large/resumable files, 5 MiB minimum per part (except final part), can retry failed parts. Use direct-to-R2 transfer and persist upload session state.
- API Worker authorizes uploads; do not buffer whole large video in Workers memory.

Refs:
- https://developers.cloudflare.com/r2/objects/upload-objects/
- https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/
- https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- https://docs.worldlabs.ai/api/reference/openapi

## Local research preparation only (NOT part of product)

The archive includes `local-tools/video-prep.mjs`, tested on `sample.mp4`. It probes and encodes an explicitly selected interval for **our one-off DL3DV research experiment**, because the downloaded dataset video is unedited. This helper is not the operator workflow, and its trimming capability must not be reproduced in the production UI.

PowerShell:

```powershell
node .\local-tools\video-prep.mjs --input "C:\Videos\downloaded-dl3dv.mp4" --inspect
node .\local-tools\video-prep.mjs --input "C:\Videos\downloaded-dl3dv.mp4" --prepare --start 15 --duration 25 --output ".\prepared\room.mp4"
```

`--start 15` is a placeholder. Choose it after watching the original video. Output is H.264 MP4, audio removed, capped at 1080p/30fps, with a report. The prepared clip should be visually reviewed before paid generation. CLI runs locally with no cloud cost.

### Compression policy nuance
- File-size reduction by itself is not success: reject output that destroys fine object details or coverage.
- Aim for an output **under** the service limit, e.g. 95 MB, not exactly 100 MB.
- Do not reduce 4K to 720p by default. Try 1080p first and measure real model output. The helper drops to 720p only if needed after earlier passes.
- The OpenAPI declares the 100 MB file-size limit; the current [video prompt guidelines](https://docs.worldlabs.ai/marble/create/prompt-guides/index.md) specify a 30-second maximum. Enforce both limits on the provider-ready file. The 29.7-second accelerated research sample succeeded, but speeding up operator footage is not part of the product workflow.
- Consider multiple room-specific clips for large properties later, not arbitrary concatenation of disjoint camera moves.

## Quality gates for ingestion
- Supported encoding/container and decode succeeds.
- Reasonable exposure, no big cuts, low blur, scene is mostly static.
- Adequate overlap and visible corners/wall-floor connections.
- No product trim step exists. Inadequate coverage or excessive duration produces a clear recapture/redelivery message for the videographer.
- Save source quality indicators for later correlation with reconstruction quality.

## Cost and lock-in
Batch transcoding on CPU is relatively simple. Avoid permanent video-transcode servers unless job volume justifies it. World Labs is a paid provider. R2 holds originals and provider-independent delivery assets so generated scenes survive provider downtime.
