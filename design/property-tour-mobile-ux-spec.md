# Mobile Property Tour Viewer — UI/UX Specification v1

**Date:** 13 November 2026  
**Status:** Design proposal, not production-verified  
**Primary task:** Open a public URL, immediately see one real room, optionally explore its AI-reconstructed 3D view, and share the tour.  
**Scope:** Mobile web, portrait-first; iOS Safari, Android Chrome, and common in-app browsers.

## 1. Product principle

**Show the property before loading the renderer.** The room is the content. Three-dimensional rendering is a progressive enhancement, not a precondition for viewing.

### Operator and visitor promises

- Operator uploads a prepared video, reviews the generated room, and publishes a stable URL.
- Visitor opens that URL without signing in.
- Visitor sees a meaningful image even if WebGL, GPU memory, or the network fails.
- Visitor explicitly chooses interactive 3D. They can return to a simple image at any time.

### V1 exclusions

No floor-plan editor, agent chat, cinematic editor, automatic walkthrough, infinite navigation, audio playback, user login, or multi-room choreography. The tour represents **one approved reconstructed room**.

## 2. Information architecture and component hierarchy

```
Public room-tour route  /t/:publicId
  ├─ Header (property identity; Share)
  ├─ Room viewport
  │    ├─ Room poster: always available
  │    ├─ Optional Three.js + Spark canvas (lazy-mounted)
  │    ├─ Status chip: Photo preview | Preparing 3D | 3D view | Photo view
  │    ├─ In-canvas controls (3D only): Reset, Zoom in/out, Fullscreen
  │    ├─ First-use hint, dismissible and transient
  │    └─ Minimal loading/fallback message
  ├─ Room name and clear primary action
  ├─ Viewer preference: Auto / Save data
  └─ Small disclosure: AI-reconstructed view, not measured geometry
```

### Mobile layout

| Area | Design |
| --- | --- |
| Header | 56 px minimum height plus top safe area; compact property name; Share button |
| Room viewport | Roughly 55% of dynamic viewport height; minimum 340 px; no forced landscape |
| Viewport corners | 16 px radius, 10 px side gutter for the prototype; can become edge-to-edge in immersion mode |
| Status chip | Top-left, readable over photo, never a major banner |
| 3D controls | Top-right vertical rail; 44 × 44 CSS px minimum hit box, 8 px gap |
| Room metadata | Short room title followed by one-sentence explanation |
| Primary action | Full-width, 52 px high, near bottom of initial view |
| Other actions | Use quieter text buttons; avoid multiple competing primary CTAs |
| Safe areas | Honor `env(safe-area-inset-*)` at top and bottom |

**Typography:** system UI font; base body 14–16 px; room title 24 px; button 14–16 px; auxiliary labels 11–12 px only when contrast passes.  
**Color:** warm neutral background, dark green primary action, high-contrast overlays; color never encodes state alone.  
**Motion:** under 150–200 ms for UI transitions; fade between poster and first 3D frame only after a frame is rendered; respect reduced-motion settings.

## 3. Screen states and transitions

### S0. Immediate room preview

- **Trigger:** Public URL opens.
- **Visible:** Property name, approved poster, room name, Share, `Explore in 3D`, `Auto quality`.
- **Invisible:** 3D canvas, renderer dependencies, loading spinner.
- **Primary action:** `Explore in 3D`.
- **Secondary action:** Stay in photo view. No interaction with 3D is required.
- **Implementation:** Ship server-rendered/static markup and an eagerly loaded responsive poster. Include explicit image dimensions and high fetch priority only for the visible poster.
- **UX rule:** A failed or slow JavaScript bundle must not hide the poster.

### S1. Prepare and load 3D

- **Trigger:** Visitor taps Explore.
- **Visible:** Poster remains in place, compact notice `Opening your room`, activity indicator, `View photo instead`.
- **Background:** Feature detection → dynamic import → fetch approved scene manifest → fetch coarse LoD data → initialize renderer → render first usable frame.
- **Message strategy:** Show actual bytes/progress only when available; otherwise use descriptive stages. Never invent a percentage.
- **Cancellation:** Selecting photo aborts work where supported, unmounts the renderer, and returns control immediately.
- **UX rule:** Never replace the poster with a blank canvas.

### S2. Interactive 3D

- **Trigger:** A first usable 3D frame renders successfully, and input handling is active.
- **Visible:** Room scene, status `3D view`, first-use gesture hint, Reset, Zoom, Fullscreen, Photo view.
- **Gesture hint:** Display briefly once per session. Do not place a blocking tutorial over the scene.
- **Adaptive detail:** Continue loading LoD refinements while preserving camera position.
- **UX rule:** Never rotate the camera automatically on entry.

### S3. Photo fallback

- **Trigger:** WebGL2 unsupported, asset failure, context-loss recovery failure, explicit Photo view choice, or performance failure.
- **Visible:** The original poster or available panorama with simple message, plus optional `Try 3D again`.
- **Message copy:** `You can still view this room. Interactive 3D isn't available right now.`
- **UX rule:** Avoid blame, raw technical errors, or repeated automatic retries.

### S4. Returning visitor

- Remember preferred quality mode locally if consent and browser settings allow it.
- Keep the poster as initial content. Do not silently launch resource-heavy 3D without explicit product-level justification.
- If a viewer is already mounted in the same page session, keep its current camera when the user resumes.

## 4. Input contract

| Interaction | Behavior | Limit |
| --- | --- | --- |
| One-finger drag inside 3D | Rotate view around a safe camera anchor | Clamp pitch, yaw, and orientation to approved limits |
| Pinch inside 3D | Zoom by changing field of view or safe orbit radius | Clamp minimum and maximum values |
| Tap Reset | Return to approved starting camera | Always available in 3D |
| Tap Fullscreen | Expand the viewer; return safely | Keep exit control, support safe areas |
| Tap Photo view | Unmount 3D and restore image | Must work even during loading |
| Tap Share | Use Web Share API if available, else copy canonical URL | No separate app required |
| Browser back / edge swipe | Perform normal browser navigation | Do not hijack platform gestures |
| Keyboard / switch input | Focus and activate all visible controls | Do not require gesture-only functions |

**Deliberate limitation:** No free walking in V1. World Labs scenes can contain inferred or inaccurate geometry. Use a constrained orbit or look-around viewpoint, not movement through unverified walls.

## 5. Progressive delivery architecture

### Source and delivery assets

Store these as separate, versioned assets:

1. Operator's original video (private).
2. Approved room poster (public, responsive AVIF/WebP/JPEG as appropriate).
3. Optional panorama image (public fallback).
4. Full-resolution SPZ (private archival source or controlled asset).
5. Optimized mobile delivery asset: direct small SPZ or prebuilt streamable RAD.
6. Desktop delivery asset if warranted by benchmarks.
7. Immutable scene manifest with asset URLs, byte sizes, camera configuration, and approval version.

### Runtime order

```
GET /t/:id
  → HTML + metadata + poster
  → render visible UI
  → visitor selects Explore
  → check WebGL2; load viewer chunk dynamically
  → retrieve approved manifest
  → request mobile 3D asset (RAD with paging, or small SPZ)
  → render first 3D frame behind poster
  → crossfade to live canvas; enable controls
  → stream further detail during idle / active viewing
  → render only when input, LoD, or page state changes
```

Spark's documented `.rad` format supports prebuilt LoD trees and paged streaming, reducing the need for phone-side preprocessing. The app should use `onDirty` to schedule frames when streaming or sorting finishes. Prebuilt LoD should be attempted after profiling, not blindly required for every small room.

**Serving requirement:** Validate HTTP Range requests, Content-Range responses, CDN caching, cross-origin headers, and handling of interrupted fetches before enabling paged RAD in production.

### Quality policy

- **Auto** (default): Selects initial asset and render quality using measured capability and frame performance, not user-agent string alone.
- **Save data**: Uses reduced detail and resolution; never forces high-resolution assets.
- Do not expose an elaborate Graphics Settings page in V1.
- Evaluate reduced pixel ratio and splat count after sustained slow frames.
- Stop animation and render work when the page is hidden or the camera is stationary.
- If performance remains too poor, offer Photo view; switch automatically only after a fatal renderer failure.
- Do not use generated imagery to assert accurate dimensions or hidden features.

## 6. Public scene manifest (illustrative contract)

```json
{
  "schemaVersion": 1,
  "tourId": "public-opaque-id",
  "room": {
    "name": "Living room",
    "posterUrl": "/assets/tours/id/v3/poster.webp",
    "panoramaUrl": "/assets/tours/id/v3/pano.jpg"
  },
  "scene": {
    "version": 3,
    "radUrl": "/assets/tours/id/v3/mobile.rad",
    "smallSpzUrl": "/assets/tours/id/v3/100k.spz",
    "initialCamera": {"position": [0, 1.5, 0], "yaw": 0, "pitch": 0},
    "limits": {"minPitch": -35, "maxPitch": 45, "minZoom": 0.9, "maxZoom": 1.5}
  },
  "published": true,
  "aiReconstructed": true
}
```

**Note:** The camera coordinates and limits above are illustrative. They must come from tested scene-specific camera data, not assumptions about measured dimensions.

## 7. Performance budgets and measurement

These are **proposed acceptance goals**, not measured results.

| Metric | Initial goal | Measurement |
| --- | --- | --- |
| LCP | ≤2.5 s, p75 mobile | Real-user Core Web Vitals |
| INP | ≤200 ms, p75 mobile | Real-user Core Web Vitals |
| CLS | ≤0.1, p75 mobile | Real-user Core Web Vitals |
| First poster | ≤2.5 s on reference mid-range 4G | Navigation timing + filmstrip |
| Tap → first interactive 3D frame | ≤6 s at 5 Mbps, reference mid-range phone | Custom performance marks |
| Active manipulation | Sustained ≥30 fps on supported reference phones | Frame timestamps and device testing |
| Fallback | Image available without 3D initialization | Browser/asset failure tests |
| Rendering idle | No continuous animation loop | Tracing and battery checks |

Break down time-to-interaction into dynamic import, manifest, first bytes, decoding, GPU initialization, and first frame. Log `3d_first_frame` only after the scene is visible and controls work.

### Device and network matrix

- Budget Android; midrange Android; older iPhone; current iPhone.
- Chrome Android, Safari iOS, WhatsApp/Instagram in-app browsers.
- Fast Wi-Fi, normal 4G, 2 Mbps plus high latency, interrupted connection.
- Low power mode, device rotation, app background/foreground, multiple tabs, WebGL context loss.

## 8. Human Interface Design checklist

- **Visibility:** Show meaningful property content at first paint.
- **Feedback:** Distinguish preparing, ready, and fallback; avoid fictional percentages.
- **Direct manipulation:** Camera follows touch smoothly and predictably.
- **Consistency:** Drag, pinch, reset, share, and browser back behave conventionally.
- **Reversibility:** Photo mode and Reset always recover a stable view.
- **Control:** Do not autoplay movement or initiate a large 3D download without user intent.
- **Progressive disclosure:** Keep renderer options inside one simple quality preference.
- **Accessibility:** Adequate hit targets, readable labels, contrast, focus outlines, reduced motion, keyboard access, and screen-reader names.
- **Trust:** Label AI-reconstructed views. Do not suggest measured architectural accuracy.

## 9. Instrumentation

Track anonymized events and actual performance:

- `tour_opened`
- `poster_visible`
- `explore_3d_selected`
- `viewer_load_started`
- `viewer_first_frame` with elapsed milliseconds and downloaded bytes
- `viewer_interacted`
- `quality_mode_changed`
- `photo_fallback_opened` with broad reason category
- `viewer_context_lost`
- `share_selected`

Avoid recording raw touch paths or personal identity. Respect consent requirements for analytics.

## 10. Acceptance tests

1. **No JavaScript:** The poster, room name, and property identity remain visible.
2. **3D code blocked:** The image remains available and the user receives a nontechnical fallback.
3. **Slow connection:** Poster appears before 3D; UI controls remain responsive throughout loading.
4. **Tap Photo while loading:** Abort work where possible and return to image quickly.
5. **WebGL context lost:** Show a recovery state, retry at most once automatically if safe, then stay in photo mode.
6. **Poor GPU performance:** Lower detail without camera jumps; offer Photo view if necessary.
7. **Reduced motion:** No forced fade or tutorial animation.
8. **VoiceOver/TalkBack:** All button names and current states are accessible.
9. **Older iPhone and budget Android:** Frame rate and time to first interaction satisfy measured gates.
10. **Share:** Canonical public URL works in an anonymous browser session.
11. **Publishing:** Unapproved scene assets cannot be loaded from the public manifest.
12. **Visual fidelity:** Operator-approved starting view, framing, and room content are retained.

## 11. Implementation order

1. Build static public tour page and responsive poster.
2. Build state machine and fallback behavior with a mock scene.
3. Integrate a small known-good SPZ scene with Spark.
4. Add a prebuilt RAD variant and compare direct SPZ against streamed RAD on target phones.
5. Implement safe camera bounds, gestures, reset, and quality policy.
6. Add telemetry and field testing.
7. Wire the page to approved World Labs outputs and permanent tour URLs.
8. Release after the mobile acceptance gates pass.

## 12. Reference documentation

- Spark, [LoD Getting Started](https://sparkjs.dev/docs/lod-getting-started/)
- Spark, [On-demand Rendering](https://sparkjs.dev/docs/on-demand-rendering/)
- Apple, [Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures)
- Apple, [UI Design Dos and Don'ts](https://developer.apple.com/design/tips/)
- Web.dev, [Core Web Vitals](https://web.dev/articles/vitals)
- MDN, [WebGL Context Lost](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/webglcontextlost_event)
