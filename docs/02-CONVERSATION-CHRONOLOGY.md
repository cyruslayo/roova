# Conversation chronology and retained context

This document summarizes the important design decisions from the multi-session discussion. It is not a verbatim transcript.

1. **World Labs exploration.** Asked how to use `https://docs.worldlabs.ai/` to build architectural visualization from property video. Identified Marble video-to-world generation, asynchronous operation tracking, downloadable Gaussian splat assets, and custom Three.js/Spark viewer.
2. **Toolcraft evaluation.** Considered `https://toolcraft.sh/` for a rich editor with canvas, inspector, keyframes, and timeline. Initially explored a studio but later rejected the need for professional editor complexity.
3. **Property platform direction.** Explored operator/visitor workflows; AI tour guide grounded in verified facts; automatic guided tours; branded exports; floor plans; view analytics.
4. **Major simplification.** User clarified that videographers make a prepared video of ONE room; the app simply uploads it, generates a scene, and publishes a URL. Operator should not edit animations or geometry.
5. **Mobile-first performance work.** Chose an immediate poster, lazy loading, 3D opt-in, touch controls, panorama/photo fallback. Spark 2.x is the preferred candidate; PlayCanvas SuperSplat/SOG is a benchmark alternative. RAD offline LoD is deferred until measured. Refer to UX spec and prototype.
6. **Backend architecture.** Proposed one TypeScript API on Cloudflare Workers/Hono, D1 metadata, R2 media, Workflows for durable generation, and CDN for static scene assets. Still only a proposal.
7. **World Labs API reference/OpenAPI analysis.** Confirmed signed media upload, video generation request with explicit model, operation polling, get-world asset URLs, optional 100k/500k/full resolution SPZ and panorama. Provider world stays private. Avoid retrying ambiguous paid starts. M1 CLI produced and eight mocked tests passed.
8. **Sample video search.** Mixkit hotel panning clip was usable as smoke test but lacked 3D coverage. User's WhatsApp phone video was 29.17s, 576×1024, compressed, with poor camera pointing consistency. GitHub panorama sample was 13.23s, 408×720, partial coverage. None was deemed sufficient for final fidelity benchmarking.
9. **Research datasets.** Investigated Meta VGGT sample videos, DL3DV-10K, ScanNet++, Tanks and Temples, and Chen931222/room-splat. DL3DV recommended as high-resolution reconstruction source for permissioned research; license CC BY-NC and separate terms. User obtained approval for DL3DV.
10. **Downloaded DL3DV sample.** A direct sample `video.mp4` link was provided; user downloaded an approximately 390 MB file to the PC, raising a major operator usability problem: size, transfer cost, and provider 100 MB limit.
11. **Local handoff.** User will continue development locally on Windows PC. ZIP includes source, UX, research, conversation summary, and a research-only FFmpeg helper.
12. **Product boundary correction (13 Nov 2026).** User explicitly rejected automatic best-segment selection, operator trimming, and editing interfaces. Videographers select and deliver a complete room clip. Platform only validates/transcodes the entire clip, reconstructs, and publishes. The DL3DV research sample still needs manual developer preparation, which does not belong in the customer product.

## Sample video assessments retained
| Source | Video details | Use |
|---|---|---|
| Mixkit hotel pan | ~8.93s, 1280x720, H.264, 2.63 MB | Basic API smoke only; little coverage |
| User phone WhatsApp video | ~29.17s, 576x1024, H.264, 3.4 MB | API smoke; dark, orientation inconsistent, much blank wall |
| GitHub `sample.mp4` room/office | 13.23s, 408x720, H.264, 3.92 MB | API smoke; partial room, low detail |
| DL3DV sample on user PC | ~390 MB, original 4K per dataset | Main upcoming research test; actual frames not inspected in this chat |

The sample videos and contact sheets previously uploaded to this chat are in `samples/`, excluding the 390 MB DL3DV file.
