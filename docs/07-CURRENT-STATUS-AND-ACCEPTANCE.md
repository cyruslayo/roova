# Current status and acceptance matrix

Date: 13 November 2026. Status labels mean exactly what is written; do not infer production readiness.

| Workstream | State | Evidence |
|---|---|---|
| Product v1 scope | Specified | Product decision docs and conversation summary |
| Toolcraft UI evaluation | Research only | Operator UI optional, visitor app independent |
| Mobile viewer UX | Prototype ready | HTML and Markdown UX spec; no working Gaussian-splat viewer |
| World Labs integration client | Implemented locally | `code/property-tour-worldlabs-m1/src` |
| Contract tests | Passed (8 mocked tests) | `npm test` verified in handoff creation runtime |
| Local video prep | Implemented locally | `local-tools/video-prep.mjs` tested against `sample.mp4` |
| 390 MB DL3DV source | Downloaded by user to PC | Not attached; contents/frame coverage not verified |
| Live World Labs generation | Succeeded privately | 29.7-second source, operation `be5caa97-8b03-4652-85ea-7425263a40b2`, world `1bc10832-cefc-4206-b4b5-7464aadaae16`, 1,600 credits charged; two earlier 61.5-second submissions failed |
| Quality inspection on real Marble output | Preliminary only | Poster/panorama sampled; full interactive geometric fidelity not approved |
| Real Spark 3D viewer | Working in local Chromium | Private poster and 100k/500k SPZ rendered from the successful world through `app/web/` + `app/api/`; drag and Photo exit exercised; geometric fidelity still needs operator review |
| Mobile benchmark | NOT DONE | No real device measurements |
| Cloudflare backend | Running locally, not deployed | `app/api/` Worker/Hono, D1 migrations, private R2, authenticated review; existing world imported locally without another provider call |
| Large upload | Local browser recovery verified | `app/api/` streams R2 parts; `app/web/` revalidates stored checkpoints and resumed an interrupted two-part upload after reload in local Chromium |
| Upload → generate → approve → public URL | Components implemented, end-to-end unverified | `app/web/`, `app/api/`, `app/processor/`; private review and source playback work locally, but browser upload/reconstruction/publication and device deployment are not verified |

## Next acceptance gates

**Gate A, local research sample:** The successful test accelerated the entire source to 29.7 seconds and encoded it to 59.26 MB. This was a research-only experiment, not a production editing option. Production Gate A requires a videographer-delivered **finished clip of at most 30 seconds**. The platform never selects, trims, or speeds up frames. It validates, optionally transcodes the entire clip, or rejects bad input.

**Gate B, provider (complete for the research sample):** The `marble-1.1` generation produced 100k/500k SPZ, poster, and panorama. The private run directory records the exact media, operation, world, and settled charge. On errors, recover by polling, not blind paid retry.

**Gate C, fidelity:** Compare generated room with source video. Record missing surfaces, invented objects, visual distortions, safe camera range and operator approval; do not publish unless faithful enough.

**Gate D, mobile:** Benchmark a genuine Spark viewer on Android/iPhone. Measure first frame time and fps and the panorama fallback. Performance targets are not guaranteed results.

**Gate E, backend:** Deploy one Worker/Workflow/D1/R2 pathway, direct (resumable for large) upload, automatic prep, durable generation and an approved public URL; verify published viewing continues if provider unavailable.

## Immediate work, not another planning round
Build and verify the real viewer against the existing private scene, then connect the operator upload, durable generation, approval, and publication flow. No additional paid generation is authorized by this document.
