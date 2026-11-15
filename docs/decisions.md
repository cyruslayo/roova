# MVP decisions

| Decision | Status | Reason |
|---|---|---|
| Use VFTCam application JavaScript | Authorized by user | The user confirms permission to use and change it. |
| Capture 37 targets | Fixed | `hotspots.js` defines 36 ring targets plus one zenith target. |
| Use on-device WebGL2 stitching | Fixed for MVP | The uploaded active renderer implements this path. |
| Use our own interface | Fixed | Stanford's visual assets are outside the supplied ZIP and product scope. |
| Use the old OpenCV stitch path | Rejected | It reads stale capture fields and depends on missing files. |
| Publish from a reviewed panorama | Product decision | The owner should inspect the result before listing visitors see it. |
| Include precise GPS in public images | Off by default | Property images can reveal a private location. |
| Backend, framework, and file store | Open | Choose from the product repository's existing services. |

The ZIP does not include the latest technical specification file. Reconcile the specification against the 37-target source before slice 2.
