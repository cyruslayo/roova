# Project instructions

## Scope

Build a mobile-first property panorama MVP with VFTCam's guided capture and WebGL2 stitching code. Use the user's permission to change the application code. Use our own product interface. Do not copy Stanford's icons, fonts, styles, or example images.

Preserve all 37 capture targets: three 12-target rings at +45°, 0°, and −45° pitch; yaw steps of 30°; one target at +84° pitch and 0° yaw. Preserve the 0.25-radian approach threshold, 0.08-radian alignment threshold, and 1,000 ms automatic capture hold. Do not test or propose fewer targets as an MVP shortcut.

Use the WebGL2 stitch path in `reference/vftcam-js/js/modules/app.js`. Audit every stitch entry point. The old `startStitching()` OpenCV route is broken and must not power product controls.

## Workflow

Work one vertical slice at a time from `docs/vertical-slices.md`. Each slice must produce a user-visible result through the product interface. Keep changes focused. Preserve unrelated work. Run the listed checks and report results. Do not mark a slice complete from syntax checks alone.

Use the project's existing app structure and storage services. Explain any new dependency or service before adding it. Keep processing on the device. Upload a finished panorama only through a clear user action.

Do not publish, deploy, or delete user data without the user's permission. Keep secrets in the approved secret store or environment variables. Keep third-party JavaScript notices when shipping its code.

## Evidence

Separate source behavior, assumptions, and verified phone results. Record browser and device models for capture tests. Record output dimensions and failed stages. Report incomplete checks and missing test fixtures.
