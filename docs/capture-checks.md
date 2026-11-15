# Slice 1 capture checks (2026-11-15)

Status: browser simulation passed; physical phone capture is **not verified**. Do not close slice 1 until a real iOS and Android capture/reload pass.

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
