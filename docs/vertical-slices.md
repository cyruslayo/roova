# Vertical slices

Work in order. Close a slice only after its user flow works in the product app and its checks pass. Keep the VFTCam target pattern fixed.

## Slice 1 — Capture and restore one target

**User outcome:** A property owner opens a room, grants camera and motion access, aligns with a target, captures one frame, and sees it again after reloading.

**Work:** Build the product capture page. Adapt the camera, permission, scene, pose, and local capture-store code. Save the JPEG and measured pose under a room session. Show clear permission and storage errors.

**Acceptance:** The saved frame has target ID, measured yaw, pitch, roll, capture time, and actual pixel dimensions. Reload restores the frame and captured marker. Capture must not mark a target complete when saving fails. Test on one target iOS phone and one target Android phone.

## Slice 2 — Complete one room panorama

**User outcome:** The owner follows all 37 targets, starts stitching, reviews one 4096 × 2048 panorama, and saves it locally.

**Work:** Preserve the three rings and zenith. Connect every stitch control to the WebGL2 path. Integrate worker preparation, FOV calibration, alignment, exposure, seams, pole fill, JPEG encoding, and local preview. Remove or isolate the broken OpenCV route from product controls.

**Acceptance:** The room contains 37 distinct target IDs before publication. No processed frame is silently skipped. The output opens in a mobile panorama viewer. Record actual output dimensions and visual defects. Test real indoor rooms on iOS and Android.

## Slice 3 — Resume and retry

**User outcome:** The owner returns to an unfinished room or retries a stitch after the browser closes.

**Work:** Scope IndexedDB captures, OPFS panoramas, and stitch jobs to the room. Reopen a dropped database connection. Keep source frames until the owner accepts the panorama. Offer a clear retry when a job was interrupted.

**Acceptance:** Reload preserves captured targets. A forced interruption during stitching can restart from saved frames. A missing source frame produces a useful error. Low-storage failure leaves the room session intact.

## Slice 4 — Publish one room

**User outcome:** The owner reviews the finished panorama, attaches it to a property room, and publishes it for visitors.

**Work:** Use the product's existing upload and listing services. Store a panorama URL, thumbnail, room name, dimensions, and publication state. Omit precise GPS metadata by default. Show upload progress and retry.

**Acceptance:** A visitor can open the room panorama from the property listing on a phone. An unpublished panorama stays private. Upload failure does not remove the local copy. Confirm storage and delivery costs with the chosen service.

## Slice 5 — Multi-room tour

**User outcome:** A visitor moves between room panoramas within one property.

**Work:** Add room navigation and ordering in the listing viewer. Keep navigation metadata separate from the JPEG and capture algorithm.

**Acceptance:** The visitor can open, switch, and return between at least two rooms on a phone. The viewer loads each panorama without changing the original images.

## Release gate

Run the project's relevant automated checks after each slice. Before release, run manual capture on supported real phones. Check motion permission, portrait frames, full coverage, black gaps, seams, memory limits, recovery, accessible controls, and listing privacy. Report the device, browser version, input set, result, and remaining defects.
