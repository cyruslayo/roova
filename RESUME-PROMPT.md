# Copy this prompt into the next local Codex / ChatGPT session

We are continuing the **Property Tour Platform** work. Read this handoff ZIP before making changes: `README-FIRST.md`, `docs/01-PRODUCT-AND-DECISIONS.md`, `docs/03-BACKEND-WORLDLABS.md`, `docs/04-VIDEO-INGEST-AND-SIZE.md`, `docs/05-MOBILE-UX-AND-PERFORMANCE.md`, `docs/07-CURRENT-STATUS-AND-ACCEPTANCE.md`, and `docs/10-VIDEO-EDITORIAL-BOUNDARY-ADR.md`. Then inspect `code/property-tour-worldlabs-m1/`, `local-tools/video-prep.mjs`, and the mobile prototype.

## Objective
Create a mobile-first product where an operator uploads a prepared room video, our system validates and optimizes it, World Labs Marble generates a 3D scene, an operator approves the visual accuracy, and the app publishes a stable URL. A visitor sees a poster instantly, then optionally enters a progressive interactive 3D room with a photo/panorama fallback. No editor complexity. One-room tours first.

## Current status
- World Labs adapter/CLI implemented; 8 mocked contract tests passed. No live provider call has been made.
- Mobile interface prototype and spec exist, but there is no working Spark viewer yet.
- Cloudflare production backend has been designed, not implemented.
- We found DL3DV footage on Hugging Face. A ~390 MB video has been downloaded **on the user's PC, NOT into this ZIP**.
- A tested local FFmpeg helper exists solely for internal DL3DV research and one-off test preparation. Its interval selection is **NOT** a production feature; videographers are responsible for preparing the complete final room recording.
- Do not claim final-quality reconstruction or production readiness until real tests are complete.

## Immediate tasks
1. For this research-only DL3DV dataset video, inspect it locally and manually choose a suitable continuous interval. This **developer benchmark step** does not define product behavior.
2. Use the local helper to prepare that sample under 100 MB. For production, never select or trim intervals: accept a complete videographer-prepared clip, transcode the whole clip when needed, or reject it with clear delivery guidance.
3. Run the contract tests. Correct any drift against the current World Labs OpenAPI spec.
4. With the user's explicit paid-test authorization and API key configured locally, submit ONE generation using the M1 CLI, then resume/poll safely. Avoid automatic retries of ambiguous paid POSTs.
5. Inspect returned world, credit cost, SPZ resolutions, poster, panorama, and spatial metadata.
6. Implement a minimal Spark viewer for the actual world assets; benchmark mobile loading and frame rate.
7. After provider success, build the first Cloudflare-backed upload → optimize → generate → approve → publish vertical slice.

## Video-size product principle
The operator should never need FFmpeg or a video editor. The videographer is responsible for selecting, trimming and finalizing one continuous clip per room. Production accepts large *finished* clips through direct R2 upload, then technically transcodes the **entire clip** when needed to satisfy provider size/format limits. Reject overlong or incomplete footage with clear instructions; do not select an interval automatically or show a trim editor. A 390 MB research source is not a representative customer-ready upload. Measure network upload performance and consider pre-upload optimization only when it is safe across devices.

## Important constraints
- CRITICAL PRODUCT BOUNDARY: capture, editorial selection, and trimming belong to the videographer. Platform only validates, transcodes without cutting, reconstructs, and publishes.
- One TypeScript application backend; Cloudflare Workers + Hono, D1, R2, Workflows are proposed, NOT deployed.
- World Labs `marble-1.1` explicitly; `WLT-Api-Key` only server-side; use private provider world and copy approved assets to our storage.
- Keep source recordings and generated assets under our control; public scenes versioned, stable `/t/:slug` URLs.
- Preserve 100k/500k SPZ first; RAD LoD and SuperSplat comparison only after real-device benchmarks justify effort.
- Respect real-estate fidelity: avoid inferred claims or altered decor; mandatory human approval.
- DL3DV is noncommercial research material by default. Do not publicly showcase it as commercial real estate without appropriate rights.
- Mobile Human Interface Design: immediate poster; touch controls; no forced autoplay, 3D opt-in, reset and fallback, accessible 44px targets, reduced motion.

Do not ask me to repeat constraints already in the handoff. Report what you actually executed, what passed, and what is still unverified.
