# Starting Codex session prompt

Act as the lead senior engineer for this mobile-first property panorama MVP.

Read `AGENTS.md`, `README.md`, and `docs/vertical-slices.md` first. Inspect the existing app and its project instructions. Check the working tree before changing files. Preserve unrelated work.

Implement **vertical slice 1: capture and restore one target**. Complete the user flow in the existing app structure:

1. Let a property owner open a room capture session.
2. Request camera and motion permission through a clear mobile interface.
3. Show a VFTCam target and its alignment feedback.
4. Capture one JPEG with its target ID, measured pose, timestamp, and pixel dimensions.
5. Save the frame under that room session.
6. Restore the frame and captured marker after a page reload.
7. Show a useful error if permission or storage fails.

Use `reference/vftcam-js` as the source-code baseline. Use our own interface. Do not copy Stanford’s icons, fonts, styles, or example images.

Preserve VFTCam’s 37-target pattern, alignment thresholds, and automatic capture hold. Do not reduce the target count. Do not connect product controls to the old OpenCV stitch path. Stitching belongs to slice 2.

Make focused changes and run relevant project checks. Test the flow in a browser. Test on iOS and Android phones if they are available. Record any device checks you cannot complete.

Finish with the files changed, the working user flow, check results, and remaining risks. Do not claim slice 1 is complete if capture and reload have not been verified.
