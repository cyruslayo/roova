# Slice 1 capture checks (2026-11-15)

## Safari restitch decode regression (2026-11-15)

- **Reported physical result:** user's phone on `staging.roova-capture-stage.pages.dev` (device, OS and browser versions not supplied; the message matches WebKit), **Restitch from originals** failed with “An error occurred reading the Blob argument to createImageBitmap.” The source frames were not changed.
- **Source cause (regression in `32450fe`):** the worker's `createImageBitmap(blob)` fails on the stored frame blob; the main-thread fallback was changed from an `<img>` element (used in `4501146` and VFTCam's fallback) to `createImageBitmap(blob)`, which fails the same way, so the whole stitch stopped.
- **Fix:** each frame is copied out of IndexedDB into an in-memory Blob first (an unreadable frame now names its target and asks for a recapture of that target only). The worker gets that copy; if the worker fails, the main thread decodes through an `<img>` element, with `createImageBitmap` only as a last resort.
- **Browser check (HeadlessChrome 153, Linux; simulates the symptom, not Safari):** with `createImageBitmap(Blob)` forced to reject with the Safari message and no worker, the replay completed a 4096 × 2048 JPEG byte-identical to the normal path (`safari-blob-fallback-9x16` in `e2e/run-stitch-replay.mjs`). `npm test` 18 passed; `npm run build:pages` passed.
- **Still required:** restitch on the same phone after redeploy, recording device, iOS and Safari versions and the Processing details list.

## Slice 2 stitch geometry repair (2026-11-15)

**Source defects fixed** (from the stitch audit): (1) the product shader replaced VFTCam's projection while keeping VFTCam's quaternion→pose conversion, so off-center image points sampled mirrored positions; (2) every frame was stretched to 512 × 768 (2:3) and vertical FOV derived from that ratio; (3) alignment, focal refinement, local warps, overlap exposure, vignetting, routed seams, pole fill and zenith recovery were missing or approximated; (4) a fixed latitude clamp left the nadir unfilled.

**Change:** `stitchRoom()` (`app/web/src/capture/stitch.ts`) now runs VFTCam's WebGL2 `renderBestPixelPanorama` with its stages, copied into `app/web/src/capture/vftcam/` (see `THIRD_PARTY_NOTICES.md`), then `fillPolesSimple` and the sky/broad-tone reference, as in `performBestPixelStitching`. Frames are resized with their own aspect (long side 1280 on iOS, 1920 elsewhere, as VFTCam's capture resolutions); frames with mismatched shapes or a decoded size that disagrees with the stored one stop the stitch with a message instead of being stretched. Poses are re-derived from each frame's stored quaternion. The FOV prior is VFTCam's 70.28° along the long side (= 43.2° short side at 9:16); the short side follows the real aspect, and FovCalibrator searches VFTCam's 41–46° range offset to that shape. Image alignment's focal refinement then adjusts it. The panorama page shows a **Processing details** list of every stage as applied, fallback or skipped. Entry points: Create / Retry / Restitch in `PanoramaRoom.tsx` → `stitchRoom()` only; no product control reaches `startStitching()`.

**Assumption, not verified:** that phone cameras keep the long-side FOV across aspect ratios. If a phone's 3:4 stream is instead cropped from the long side, the prior is wrong by ~28% in focal length and the stitch fails (see the control case below). Real phone frame dimensions and FOV still need recording.

**Numerical check** (`src/capture/stitch-geometry.test.ts`): 10 asymmetric image points × 37 targets, aspects 9:16 and 3:4, roll 0/±5°: capture quaternion → world → ERP pixel as `PanoramaViewer` displays it → shipped `projectToCamera`: **370/370 per case** recover their source pixel.

**GPU replay** (`app/web/e2e/stitch-replay.*`, HeadlessChrome 153 Linux, SwiftShader WebGL2 — not a phone, not a real room): a procedural room with asymmetric textured content rendered into 37 JPEG frames, stitched by the product `stitchRoom()`. All outputs **4096 × 2048**, no black pixels in any band, ~17–19 s. Mean absolute error /255 (fraction within 20) by latitude band, ceiling / upper / equator / lower / floor:

| Case | Error | Mirrored control |
|---|---|---|
| exact poses, 720 × 1280 | 9.0 (0.95) / 7.0 (0.96) / 6.3 (0.97) / 9.7 (0.95) / 4.2 (1.00) | 35–69 |
| ±1.5° yaw/pitch, ±1° roll sensor error, ±25% exposure, 720 × 1280 | 28.5 (0.29) / 12.1 (0.89) / 9.9 (0.90) / 18.9 (0.85) / 6.1 (0.99) | 47–64 |
| exact poses, 960 × 1280, camera matching the prior | 7.0 (0.96) / 9.5 (0.95) / 5.4 (0.98) / 8.9 (0.96) / 3.7 (1.00) | 34–68 |
| control: 960 × 1280 with a 43.2° short side (prior mismatch) | 59 / 40 / 40 / 42 / 15.5 — **fails** | 58–64 |

Alignment logs: exact 99/99 pairs, misfit 1.00° → 0.13°; pose-error 84/91 pairs, 2.09° → 0.15°, max correction 2.61°. The ERP is upright and unmirrored; the viewer's heading origin is a constant quarter turn from target 13 (a yaw offset, not a defect in geometry).

**Remaining visible defects in the replay:** with sensor error, the low-texture ceiling near the zenith shows doubled checker edges, and one small kink appears near +60°. These are synthetic-scene results; real rooms add parallax and blank walls.

**Still required:** replay the user's original 37 frames (staging origin, original phone) through Restitch and inspect window frames, wall edges, floor lines, ring boundaries and the wrap; then iPhone/Safari and Android/Chrome runs with device, OS and browser versions, frame dimensions, output dimensions, stage list, memory behaviour and visible defects recorded. The supplied 1080 × 540 WhatsApp JPEG has neither frames nor poses and cannot be replayed. Slice 2 is **not** complete.

**Checks:** `app/web` `npm test` 18 passed; `npm run build` passed (existing large-chunk warning).

## Safari panorama-save follow-up (2026-11-15)

- **Reported physical result:** iPhone XS Max / Safari (versions not supplied): after all 37 targets, stitching reached local panorama storage and failed with `t.createWritable is not a function`. Actual saved output dimensions and visual stitch quality remain unverified. The 37 original IndexedDB frames were not deleted by this path.
- **Source cause:** `savePanorama` tested only `navigator.storage.getDirectory`, then called `FileSystemFileHandle.createWritable` unconditionally. This does not imply that Safari exposes writable file streams. The fix checks the file handle, uses a dedicated worker with `createSyncAccessHandle` where supported, and persists the blob in the existing room-scoped IndexedDB store if OPFS cannot write. Each new OPFS save uses a unique filename, so a failed restitch cannot overwrite an older saved panorama. The UI keeps an encoded JPEG available for download and **Retry save** without re-stitching if local persistence fails.
- **Browser regression checks (Windows headless Chrome, not Safari):** reproduced the exact `handle.createWritable is not a function` message with `getDirectory` present and a file handle lacking that method. With worker unavailable, IndexedDB fallback saved a blob with all 37 source IDs and restored it after reload. With a wrapped main-thread file handle lacking `createWritable`, worker-based synchronous OPFS writing saved and restored the file after reload. No actual Safari worker test is available here.
- **Retry UI fixture (Windows headless Chrome):** forced the panorama IndexedDB write to throw `QuotaExceededError` after a 37-frame stitch. The 4096 × 2048 preview and download remained available with **Retry save**. Removing the simulated failure and retrying saved the same JPEG without restitching; it restored after a reload. No page exceptions.

Status: user reports 37 guided captures on iPhone XS Max/Safari; JPEG metadata and reload were not recorded. Android capture and real-phone stitching remain **unverified**. Do not close slices from desktop simulation alone.

## Full-room handoff and panorama test build (2026-11-15)

- **Reported physical result:** iPhone XS Max, Safari; user captured **all 37 guide points**. iOS/Safari version, captured JPEG dimensions, and reload behavior were not supplied. After target 37 the UI incorrectly said “Turn slowly to find a target.” The new completion state detects 37 distinct saved IDs, stops capture, and offers **Create panorama**, including when an existing room is reopened. The new room table backfills the old tour ID as its first room ID; existing Safari IndexedDB keys remain valid.
- **Source behavior:** Product stitch controls route only to `app/web/src/capture/stitch.ts`, a device-local WebGL2 texture-array best-pixel adaptation of `reference/vftcam-js/js/modules/app.js` (`performBestPixelStitching` / `renderBestPixelPanorama`). The old `startStitching()` route has no product entry point. Sequential worker preparation has a main-thread fallback. FOV comparison uses neighboring equator captures, with a baseline when image texture is insufficient. Alignment uses measured capture poses and conservative equator image overlap corrections; exposure gains, agreement-weighted seam feathering, nadir fill, and JPEG encoding run on device. This is a focused adaptation, not evidence of matching the reference's full long-running outdoor quality or every seam/warp optimization.
- **Local integration, not phone evidence:** Windows headless Chrome with a 37-JPEG synthetic fixture created a **4096 × 2048** JPEG, saved it locally, reopened the interactive viewer after reload, and restored an IDB v1 frame after the v2 upgrade without changing its room ID. Worker asset served; no page exceptions. Solid-color synthetic input cannot expose ghost seams, gaps, or image alignment defects.
- **Local API/visitor fixture:** Local D1 migrations 0001–0003 applied; a tour created its first room with its prior ID, second room added, owner-only finished-JPEG/thumbnail upload returned staged, public listing returned 404 before publication, explicit publication exposed one panorama, and a second published room appeared in changed order. Local visitor Chrome switched between Kitchen and Living room. A later upload preserved the already-published image until explicitly republished. All media in this test were generated solid-color fixtures, not a user's captures.
- **Still required:** Reopen the user's original Safari session on the exact staging origin; run stitch/reload, record actual 4096 × 2048 output or failure stage, inspect black gaps/seams/memory behavior, test explicit upload/public link, and test Android Chrome. Do not call slices 1–5 accepted from desktop fixtures.
- **Staging deployment:** additive room migration applied to `roova-capture-stage-db`; preview alias now serves commit `7df590d`. Cloudflare Access continues to redirect anonymous Studio/operator API requests (302), while visitor assets and public panorama API bypass Access. A signed-in Safari run has not yet been observed for this build.

## Guide scene correction (2026-11-15)

- **Reported on device:** iPhone XS Max, Safari (iOS/Safari version not recorded): no spatial guide spots. This was confirmed as a source omission: the product rendered a fixed reticle and a 37-item progress grid, but no 3D capture scene. A successful physical capture was not reported.
- **Source adaptation:** `app/web/src/capture/GuideScene.ts` renders VFTCam-style inside-out guide sphere, latitude/meridian lines, all 37 world-positioned spots, near/aligned colors, and curved photo patches with zenith projection. The render quaternion and capture selection use the same target positions; patches only appear for saved frames, including after reload. Camera viewport sizing uses `ResizeObserver` rather than window dimensions. Safari's orientation and motion permissions are now both requested from the same user gesture; missing level readings are no longer treated as level.
- **Desktop browser check:** headless Google Chrome on Windows, viewport 390 × 844, fake camera and mocked room API: 37 targets visible on WebGL overlay. Mocked orientation/motion permissions and repeated sensor readings aligned target 19 for the automatic hold, saved a frame as **1 / 37**, and restored **1 / 37** after reload with no page exceptions. A separate locally inserted **320 × 560** JPEG fixture for target 19 restored its saved marker and displayed its pink photo patch in the sphere after reload. These are simulated browser checks, not phone results; the fake-camera capture dimensions were not separately recorded for this correction.
- **Automated checks:** `app/web` 7 tests passed, `npm run build:pages` passed; `app/api` 4 tests passed. Vite still emits the existing large-chunk warning. Real iPhone XS Max Safari and Android Chrome guidance, level and capture still require retesting on devices.

## Source behavior adapted

- `reference/vftcam-js/js/modules/hotspots.js`: 37 IDs in three 12-target rings at +45°, 0°, −45° and a +84° zenith.
- `reference/vftcam-js/js/modules/scene.js`, `app.js`, `capture-orientation.js`: portrait-camera quaternion, 3D nearest-target angle, 0.25/0.08 radian thresholds, 1,000 ms continuous hold, and measured pose from the frame-time quaternion.
- `reference/vftcam-js/js/modules/camera.js`, `database.js`: camera frame to JPEG; IndexedDB blob persistence. Product writes are room-scoped and wait for transaction completion before marking capture.
- Product UI uses Stillroom's own style and existing Lucide icons. No reference-site visual assets are used. No product stitch control was connected to the legacy OpenCV path.

## Automated and browser checks

- `app/web`: `npm test` (6 tests passed) and `npm run build` passed; Vite reported its existing large-chunk warning.
- Local API + Vite proxy, headless **Google Chrome desktop**, emulated viewport **390 × 844**, fake camera stream and scripted orientation event: authenticated existing room opens; 37 markers render; permission-denial message displayed when motion request denies; granted motion simulation aligns target 1 and captures after the hold.
- IndexedDB record had room ID, target ID 1, measured yaw **0°**, pitch **45°**, roll **180°**, orientation quaternion, ISO capture time, and a nonempty **image/jpeg** blob. Fake-camera frame decoded at **1080 × 608** pixels, matching stored dimensions. After page reload, the same frame and one captured marker appeared.
- Forced IndexedDB `put` to throw `QuotaExceededError`: useful low-storage error shown, zero captured markers; restoring storage and tapping **Retry capture** saved the frame, and reload restored it. A second room's capture remained scoped to its own tour ID.
- These checks simulate the camera and sensors. The desktop fake-camera dimensions are **not** evidence of portrait output on a phone.

## Device checks still required

- iPhone model, iOS version, Safari version: **not available in this environment**. Check user-gesture motion prompt, rear camera, portrait frame orientation/dimensions, real-sensor target alignment and 1-second hold, reload, and permission denial. Record results.
- Android phone model, OS version, Chrome version: **not available in this environment**. Check the same capture and reload flow, especially motion events and frame dimensions. Record results.
- Physical-device storage failure, app background/foreground recovery, and long-running camera memory use remain unverified.
