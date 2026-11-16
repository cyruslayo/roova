# VFTCam gap audit (2026-11-16)

A second, full pass over `reference/vftcam-js` against the product (`app/web`). Every claim below was read in the source; the main ones were re-checked by hand after four read-only audits (capture; frame preparation and orchestration; output, viewer and storage; settings and field of view). Nothing here was run on a phone. File references: `app.js` = `reference/vftcam-js/js/modules/app.js`.

## Already faithful (no action)

- **Stitch math.** Every method copied into `app/web/src/capture/vftcam/stitcher.js` matches `app.js` line for line (overlap gains, whole-frame gains, vignetting, projection, `renderBestPixelPanorama` with its shaders, sky reference render and apply, image alignment with focal refinement, local warps and zenith recovery, compile, ERP centres). The only additions are the alignment diagnostics. `seam-finder.js`, `zenith-alignment.js`, `pole-fill-simple.js` and `hotspots.js` are identical apart from headers; `fov-calibrator.js` differs only by the documented `aspect` option.
- **Stitch settings.** Every value the stitcher reads from VFTCam's storage toggles resolves to VFTCam's normal-user default (gain ridge/range/midtones, vignetting 1, image alignment and local warp on, overlap gains, seam routing on, feather 0.06, agreement 0.08–0.35, sky reference 1, roll correction 0, post-equalisation off, multi-band off).
- **Capture rules.** 37 targets, 0.25/0.08 rad thresholds, 1,000 ms hold, 8° level tolerance with the zenith exemption, tilt from `accelerationIncludingGravity`, quaternion and pose formulas, JPEG 0.85 capture and 0.9 output, 4096 × 2048 output, layer order, readback and flip.
- **Not gaps (dead or no-op in VFTCam):** `SimpleAligner` (horizontal 0; roll term ignored by the render), `applyMultiBandBlending` (`skipMultiband = true`), `postExposureEqualizeERP` (strength 0), `computeIntensityRatio`, `FovEstimator`, `drawToPortraitCanvas`, `normYaw`, `SmartImageLoader`, `MemoryMonitor`, `worker-client.js`, `multi-stitcher.js`/`stitching.js`/`image-manager.js` (OpenCV route only), `restitch()`/`stitchExisting()`, `cancel()`.
- **VFTCam bugs not to copy:** the "reduced quality" retry never reduces quality (`stitch-processor.js:41` resets `emergencyMode`); `fallbackToMainThread` is never set; the context-loss message promises a retry that never happens (`app.js:1799`); outdoor slider labels 44.7°/72.3° disagree with the stitch base 45.7°/73.3°; GPS date uses local time while GPS time uses UTC; XMP dates are written with `Date.toString()`; the OpenCV `startStitching()` entry points.

## Gaps, grouped by what they affect

### A. Stitch geometry (directly affects the blur)

**Status 2026-11-16: A1–A4 added** (panorama page → Camera settings for this phone; see `docs/capture-checks.md`). Not yet verified on a phone. At the iPhone's measured field of view the 37-target pattern leaves small uncovered areas, which group A does not address.

| # | VFTCam | Product | Add |
|---|---|---|---|
| A1 | Per-device field-of-view fine-tuning: horizontal and vertical sliders ±5° in 0.5° steps, saved per capture mode (`card-ui.js:209-248, 1044-1145`; `capture.js:612-650`). Non-zero offsets **replace** auto-calibration (`app.js:1944-1953`). | None; always auto-calibrates 41–46°. | A product "camera field of view" setting, per device, with a stitch preview. Measured need: the iPhone frames fit ≈37° × 62°, below even VFTCam's slider floor (38.2°), so the range must reach lower. |
| A2 | Precedence: test override (`overrideFOV`/`overrideVFOV`, `manual-fov-test.js`) → saved offsets → calibration unless `skipCalibration` → mode base (`app.js:1922-1972`). | Calibration → aspect baseline. | Same precedence, with the override as a developer setting. |
| A3 | Indoor/outdoor capture mode toggle; default **outdoor** 45.7° × 73.3° (`capture.js:600-660`, `inline-2.js:9-26`, `app.js:1900-1913`). | Fixed indoor 43.2° × 70.3°. | A mode setting (default indoor for property rooms), each mode keeping its own FOV offsets. |
| A4 | Tripod mode: nadir fill disc of 22° (`app.js:2078`, toggle read at `inline-2.js:30`). | `nadirDeg: 0` always (`stitch.ts`). | A tripod switch that passes 22. |

### B. Capture quality and cadence

| # | VFTCam | Product | Add |
|---|---|---|---|
| B1 | Tilt (level) averaged over the last 10 accelerometer samples (`app.js:166-172, 686-694`). | Single raw sample (`CaptureRoom.tsx:167-170`). | 10-sample average. |
| B2 | 500 ms cooldown after each capture (`app.js:1006-1008`). | None; the next hold can start at once. | Same cooldown. |
| B3 | Waits for a ready, playing stream: `loadeddata`, `play()` + 100 ms, 500 ms if `currentTime < 0.5`, then draws inside `requestAnimationFrame` (`camera.js:136-164`). | Throws "Camera frame is not ready" and needs a tap on Retry (`CaptureRoom.tsx:120`). | Same waits and rAF draw. |
| B4 | Stops the camera when the page is hidden and restarts on return (`capture.js:305-320`). | Stream keeps running while hidden. | Same visibility handling. |
| B5 | Missing motion data counts as level (`app.js:172`); motion denial alerts but continues (`capture.js:356-359`). | Blocks until `devicemotion` arrives; motion denial blocks capture. | Keep the product's stricter gate (it protects frame quality) but show why; no change to thresholds. Decision for the user. |
| B6 | Manual capture button and spacebar (`app.js:447-475, 585-589`). | Automatic only. | A manual capture control, still requiring alignment within 0.08 rad. |
| B7 | Per-capture `compassYaw`, `hasCompass` (iOS `webkitCompassHeading`, Android absolute alpha; `app.js:630-644, 919-946`), `yawDelta`, `pitchDelta`, `fov`, `orientationVersion`, epoch `orientationTimestamp` (`app.js:954-976`). | Not stored. | Store them (compass used for B8/C3). |
| B8 | Compass calibration offset (`permissions.js:857-937`). | None. | Same, used only for the panorama's initial heading. |
| B9 | Portrait lock where supported and a landscape warning that pauses capture (`device-detector.js:105-226, 316-348`); desktop warning (`device-detector.js:59-102`). | None. | Same. |
| B10 | Roll indicator line, proximity-tinted border, per-second countdown, progress ring, milestone announcements (`app.js:680-704, 776-837, 1030-1068`). | Text status, reticle states, dot grid. | Countdown and roll indicator in the product's own style (no VFTCam visuals copied). |
| B11 | Persisted permission states (`permissions.js:46-58, 177, 190-214`). | Re-asks each load. | Persist states. |
| B12 | Camera enumeration/switching (`camera.js:30-94`). | Rear camera only. | Optional; reachability in VFTCam's UI is unclear. |
| B13 | Partial stitch with confirmation (`app.js:450-470`). | All 37 required. | **Not added**: project rules require all 37 targets. |

### C. Output file

| # | VFTCam | Product | Add |
|---|---|---|---|
| C1 | EXIF (Make, Software, DateTime, DateTimeOriginal/Digitized, dimensions) via piexif (`metadata-utils.js:27-68`). | No metadata. | EXIF block (dates ISO-correct). |
| C2 | GPano XMP: UsePanoramaViewer, ProjectionType equirectangular, cropped/full pano sizes, initial view heading/pitch/roll/FOV, pose heading, first/last photo dates, source count, creator tool, `dc:description` stitch log (`metadata-utils.js:102-150, 161-227`). Without it, Google Photos and similar apps do not treat the JPEG as a 360° photo. | None (the `stitcher.js:453` comment claiming XMP is wrong). | GPano XMP with an APP1 length guard; stitch log included. |
| C3 | Initial view heading from the first capture's compass yaw (`app.js:2250-2263`). | Viewer starts a quarter turn from target 13. | Initial heading from compass when available, else target 13. |
| C4 | GPS latitude/longitude/altitude in EXIF when permitted, with a share toggle (default on) that strips it (`metadata-utils.js:50-59, 262-280`; `card-ui.js:194-198, 826`). | None. | **Off by default** (Slice 4 says omit precise GPS by default); opt-in only, stripped from shared copies. |
| C5 | Gallery thumbnail 800 × 400, q0.8 saved with the panorama (`memory-utils.js:560-575`). | Thumbnail only at upload. | Save a local thumbnail. |
| C6 | File name `photosphere_YYYYMMDD_HHMMSS.jpg` (`frame-export.js:51-55`). | `stillroom-<roomId>-panorama.jpg`. | Room name + timestamp. |

### D. Viewer and sharing

| # | VFTCam | Product | Add |
|---|---|---|---|
| D1 | Zoom (30–120° hFOV, wheel, keyboard, controls), fullscreen, auto-rotate (`app.js:1342-1380`, `camera-roll.js:627-634`). | Drag only, fixed 75°. | Pinch/wheel zoom 30–120°, fullscreen, optional auto-rotate. |
| D2 | Gyro/VR viewer: device-orientation look-around, side-by-side stereo with adjustable eye spacing, recenter, HUD, landscape lock (`vr-viewer.js`). | None. | Gyro "look around" mode; stereo VR optional. |
| D3 | Web Share with the JPEG file, download fallback (`share-utils.js:99-172`). | Download link only. | Share sheet with the file, download fallback. |
| D4 | Bulk ZIP of all panoramas (`camera-roll.js:862-1054`). | None. | Lower priority (one panorama per room). |

### E. Storage, recovery and housekeeping

| # | VFTCam | Product | Add |
|---|---|---|---|
| E1 | `navigator.storage.persist()` and an iOS storage-risk/install warning (`pwa-status.js:91-121, 225, 281-313`). | None. | Request persistence; warn when not granted. |
| E2 | Delete a panorama with confirmation (OPFS file then record; `camera-roll.js:1062-1108`, `database.js:484-513`); clear all captures; start-over session reset (`app.js:1413-1449, 1504-1568`). | No delete or reset; error messages say "recapture target N" but there is no way to. | Retake one target, start the room over, delete the panorama (all confirmed). |
| E3 | Old OPFS file removed on delete. | Every restitch writes a new OPFS file and never deletes the previous one; a failed worker write leaves an empty file (`storage.ts:76-89`). | Remove the replaced file after a successful save. |
| E4 | Stitch-job recovery prompt with Retry/Discard, 7-day expiry, missing-frame check (`stitch-recovery.js`). | In-page notice and Retry only. | Discard option, expiry, missing-frame check. |
| E5 | Worker retries with backoff (3 attempts), 30 s stall watchdog with heartbeats (`stitch-processor.js:62-182`; `stitch-worker.js:12-20`). | One worker try, then main thread; 15 s per-frame timeout. | Watchdog and retries. |
| E6 | 10 MB per-frame size guard (`database.js:224-232`); private-browsing warning (`database.js:638-689`); connection reopen after Safari drops it (`database.js:129-205`). | None / new connection per call. | Size guard and private-mode notice. |
| E7 | Service worker and manifest for offline use and installation (`service-worker.js`). | None. | Needed for E1 on iOS (installed apps keep storage). |

## Measured context for A1

From the exported iPhone frames (iOS 18.7, Safari 18.7.3): direct image alignment agrees best at a 37° short side (agreement 0.59 against 0.12–0.20 at 41–45°, with smaller corrections); single-pair dense checks give 36–41°. Stitching at 37° sharpens the fan, door cornice and TV area but leaves uncovered arcs near +80° latitude, because the 37-target pattern assumes VFTCam's wider camera. A1 alone therefore needs a coverage answer for narrower cameras (a wider camera stream, or filling those arcs), not fewer targets.

## Suggested build order

1. **A1–A4** (field of view setting, precedence, mode, tripod) with an automatic estimate and a desktop replay check on the exported frames, then a phone run.
2. **C1–C3, C5, C6** (metadata, heading, thumbnail, name); C4 opt-in only.
3. **B1–B4, B7, B8** (capture cadence and stored fields), then **B6, B9–B11**.
4. **E2, E3, E1, E4** (retake/reset/delete, orphan files, persistence, recovery), then **E5, E6, E7**.
5. **D1, D3**, then **D2**, **D4**.
