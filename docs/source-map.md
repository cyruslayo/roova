# JavaScript source map

The uploaded snapshot is in `reference/vftcam-js`. Keep it intact for comparison while product modules move into the app.

| Concern | Source files | Integration note |
|---|---|---|
| Target pattern | `js/modules/hotspots.js` | 37 positions, including the +84° zenith. |
| Camera frame | `js/modules/camera.js` | Confirm actual portrait frame dimensions on phones. |
| Sensors and pose | `js/modules/scene.js`, `js/modules/capture-orientation.js`, `js/modules/permissions.js`, `js/modules/compass-utils.js` | Save pose with the frame. |
| Guided capture | `js/modules/app.js`, `js/modules/scene.js` | Replace Stanford-specific DOM wiring with product UI. |
| Stitch preparation | `js/modules/stitch-processor.js`, `js/workers/stitch-worker.js` | Preserve worker retry and main-thread fallback. |
| WebGL2 stitch | `js/modules/app.js`, `js/modules/seam-finder.js`, `js/modules/simple-aligner.js`, `js/modules/fov-calibrator.js`, `js/modules/fov-estimator.js`, `js/modules/zenith-alignment.js`, `js/modules/pole-fill-simple.js` | Keep alignment, exposure, seam, and pole stages. |
| Local data and recovery | `js/modules/database.js`, `js/modules/opfs-storage.js`, `js/workers/opfs-worker.js`, `js/modules/stitch-recovery.js` | Add room-specific keys in product storage. |
| Metadata and viewing | `js/modules/metadata-utils.js`, `js/ext/pannellum.js` | Omit precise GPS by default. |
| Third-party runtime | `js/ext/three.min.js`, `js/ext/piexif.min.js`, `js/ext/pannellum.js` | Keep license notices. |
| Optional ZIP export | `js/ext/jszip.min.js`, `js/modules/frame-export.js` | Omit from MVP unless export is in scope. |
| Legacy route | `js/modules/stitching.js`, `js/modules/multi-stitcher.js`, `js/modules/opencv-utils.js`, `js/modules/worker-client.js` | Do not wire product controls to this route. |

`app.js:450-470` calls `startBestPixelStitching()` from one control. Other controls call the old `startStitching()` path through `app.js`, `capture.js`, and `card-ui.js`. Route every product control to the WebGL2 path.

The `service-worker.js` and `sw.js` files remain in the reference snapshot. They refer to missing site assets. Create a product service worker only after the app has a working page and asset list.
