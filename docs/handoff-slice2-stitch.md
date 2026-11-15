# Handoff: Slice 2 stitch repair (2026-11-15)

Read `AGENTS.md`, `docs/vertical-slices.md`, and the top section of `docs/capture-checks.md` first. `RESUME-PROMPT.md` and `README-FIRST.md` describe an older World Labs/video plan and do not reflect the current capture-and-stitch work.

## Where things stand

- **Branch:** `claude/exciting-franklin-7psq6u` on `github.com/cyruslayo/roova`. Commit `32450fe` holds the stitch repair on top of `4501146`. No pull request has been opened.
- **Slice:** Slice 2 (complete one room panorama). **Not complete.** It needs a real-room replay and phone runs on iOS and Android.
- **Staging:** the user reports deploying this branch to `https://staging.roova-capture-stage.pages.dev` with wrangler from a fresh local clone. The cloud session did not see that deploy and has not verified it. No database migration was needed; this change is frontend-only.

## What changed and why

The audit (summarized in `docs/capture-checks.md`) found:

1. **Projection mismatch.** `core.ts` copies VFTCam's quaternion→pose conversion, but the product shader replaced VFTCam's projection. Off-center image points sampled mirrored positions, so the stitch broke into inverted patches.
2. **Stretched frames.** Every frame was forced to 512 × 768 (2:3), and the vertical field of view was derived from that ratio.
3. **Missing stages.** Alignment, focal refinement, local warps, zenith recovery, overlap exposure, vignetting, routed seams and pole fill were missing or approximated.
4. **Black floor band.** A fixed latitude clamp left the bottom unfilled.

The fix:

- `app/web/src/capture/stitch.ts`: `stitchRoom()` now returns a `StitchResult` with the blob, sizes, field of view and a list of stages. It runs VFTCam's `renderBestPixelPanorama`, then `fillPolesSimple`, a readback with a vertical flip, `applySkyReference` and JPEG encoding, in the order of VFTCam's `performBestPixelStitching`.
- **Frame preparation:** each frame keeps its own aspect ratio. The long side is capped at 1280 px on iOS and 1920 px elsewhere, matching VFTCam's capture resolutions. A mismatched shape, or a decoded size that disagrees with the stored one, throws an error instead of stretching.
- **Poses:** re-derived from each frame's stored quaternion (`stitchPose`).
- **Field of view:**
  - The prior is 70.28° along the frame's long side, which equals VFTCam's 43.2° short side at 9:16. The short side follows the frame's real aspect.
  - `FovCalibrator` searches VFTCam's 41–46° range, shifted to match the frame shape.
  - Image alignment refines focal length afterwards.
- `app/web/src/capture/vftcam/`: VFTCam code.
  - `stitcher.js` holds methods copied verbatim from `reference/.../app.js`. Only the `sessionStorage`/`localStorage` debug toggles are replaced, with fixed reference defaults for indoor mode.
  - `fov-calibrator.js` takes an `aspect` option in place of its 9:16 constants.
  - `seam-finder.js`, `zenith-alignment.js`, `pole-fill-simple.js` and `hotspots.js` are copied unchanged.
  - Each file has a header naming its source, and `THIRD_PARTY_NOTICES.md` lists them. The `.d.ts` files give TypeScript types.
- `stitch-worker.ts`: also returns the decoded source size.
- `PanoramaRoom.tsx` and `ui/styles.css`: a **Processing details** section under the viewer lists frame size, field of view and each stage as applied, fallback or skipped.
- **Unchanged:** all 37 targets, the 0.25 / 0.08 radian thresholds and the 1,000 ms hold. The Create, Retry and Restitch buttons reach only `stitchRoom()`; no product control reaches VFTCam's OpenCV `startStitching()`.

## Evidence

**Verified in the cloud session (Linux):**
- `app/web`: `npm test`, 18 tests passed. `npm run build:pages` passed, with the existing warning about large chunks.
- `app/api`: `npm test`, 5 passed. `npm run typecheck` passed.
- `src/capture/stitch-geometry.test.ts`: 10 asymmetric image points × 37 targets, at aspects 9:16 and 3:4, with roll 0° and ±5°. The chain is capture quaternion → world → the ERP pixel `PanoramaViewer` displays → shipped `projectToCamera`. All 370 points per case return to their source pixel. The old equations fail.
- **GPU replay** (`app/web/e2e/`, HeadlessChrome 153 on Linux with SwiftShader WebGL2): synthetic textured room. All outputs are 4096 × 2048 with no black pixels. Full table in `docs/capture-checks.md`.
  - Exact poses at 9:16: mean error 6–10 out of 255 across bands.
  - ±1.5° pose error: walls 10–19. The ceiling scores 28.5, with doubled checker edges near the zenith and one small kink near +60°.
  - 3:4 frames matching the field-of-view prior: 5–10.
  - 3:4 frames *not* matching the prior: fails at about 40.

**Assumptions, not verified:**
- Phone cameras keep the long-side field of view across aspect ratios. If a phone's 3:4 stream is cropped differently, stitching fails, as the control case shows.
- The real phone frame dimensions and field of view have never been recorded.

**Not done:**
- No real-room or phone stitch.
- The 1080 × 540 WhatsApp JPEG has neither frames nor poses, so it cannot be replayed.
- No memory measurement on iOS. iOS uses 720 × 1280 frames, as VFTCam does, but the 37-frame GPU and canvas memory there is unmeasured.

## Next steps

1. On the original phone at the staging origin, open the room. If it shows **37 / 37 views saved**, tap **Retry panorama** or **Restitch from originals**.
2. Record:
   - device model, OS version and browser version;
   - the Processing details list (frame size, field of view, each stage's status);
   - time taken, and any crash or reload;
   - the last progress message if processing fails.
3. Inspect window frames, wall edges, floor lines, ring boundaries, the zenith and nadir, and the horizontal wrap.
4. Repeat on Android Chrome. Add results to `docs/capture-checks.md`, keeping source behavior, assumptions and verified phone results separate.
5. If a stage reports **fallback** on a phone, investigate that stage before tuning anything else.
6. Known follow-ups, only if real results call for them:
   - ghosting near the zenith under pose error;
   - the viewer opens a quarter turn away from target 13 (its starting heading; the geometry is correct);
   - widening the field-of-view search if real phones disagree with the prior.

## Update after the first successful iPhone restitch (2026-11-15)

The restitch now completes on iPhone Safari (4096 × 2048), but **Image alignment reported fallback**, so frames sat on raw sensor poses; that matches the doubled cornices, fan and edges. See the top entry of `docs/capture-checks.md`.

- Processing details now explain an alignment fallback (exception text, or the null-return stage with corner/pair/match counts). Diagnostic only.
- New **Export source frames** button (ZIP of the 37 original JPEGs + `poses.json`, on device, never uploaded) and `--recorded` mode in `e2e/run-stitch-replay.mjs` to replay it on desktop at the iPhone's 1280 px cap.
- Next: redeploy (needs the user's go-ahead), restitch and export on the iPhone, read the alignment reason, replay the ZIP locally, then decide the fix. Exposure, broad tone, FOV, seam and vignetting tuning wait until alignment runs on the real frames.
- Local Playwright: not a project dependency. `NODE_PATH=C:/AI2026/pin-atlas/node_modules` (Playwright 1.64.1, already on this machine) works for the runner.

## Running the checks locally (Windows PowerShell)

```powershell
cd app\api; npm ci; npm test; npm run typecheck
cd ..\web; npm ci; npm test; npm run build:pages
```

The GPU replay drives the browser with Playwright, which is **not** a project dependency; the cloud session used a preinstalled copy. To run it locally, install Playwright and Chromium outside the project, or ask before adding it as a dev dependency:

```powershell
cd app\web
npx vite --port 5179 --strictPort   # in one terminal
$env:NODE_PATH = (npm root -g); node e2e/run-stitch-replay.mjs e2e/out   # in another; needs a global playwright
```

The output goes to `app/web/e2e/out/`, which is git-ignored: `results.json` plus a 2048 × 1024 preview per case.

## Local setup note

`C:\AI2026` itself is a Git repository. Running `git fetch` or `git checkout` from a plain subfolder such as `project-tour` or `property-tour` acts on that outer repository. Use the dedicated clone (for example `C:\AI2026\roova`). `git status` there must not list any `../` paths.
