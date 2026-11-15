# Third-party JavaScript notices

The reference snapshot includes these bundled libraries. Include a license file for each library that the product ships. Keep this list aligned with the final build.

| File | Library | License choice | License file |
|---|---|---|---|
| `reference/vftcam-js/js/ext/three.min.js` | Three.js r128 | MIT | `licenses/three-LICENSE.txt` |
| `reference/vftcam-js/js/ext/pannellum.js` | Pannellum 2.5.6 | MIT | `licenses/pannellum-COPYING.txt` |
| `reference/vftcam-js/js/ext/piexif.min.js` | piexifjs 1.0.6 | MIT | `licenses/piexifjs-LICENSE.txt` |
| `reference/vftcam-js/js/ext/jszip.min.js` | JSZip 3.10.1 | MIT option of dual MIT/GPLv3 license | `licenses/jszip-LICENSE.txt` |

JSZip supports optional ZIP export. If the final product omits it, remove its bundled file and notice. These notices do not describe the user's separate VFTCam application-code permission.

## VFTCam application code shipped in the product

`app/web/src/capture/vftcam/` contains VFTCam application code used under the user's separate permission (not one of the MIT libraries above): `seam-finder.js`, `zenith-alignment.js`, `pole-fill-simple.js` and `hotspots.js` copied unchanged; `fov-calibrator.js` with its 9:16 constants replaced by the frames' real aspect; and `stitcher.js`, whose methods are copied from `reference/vftcam-js/js/modules/app.js` (`computeOverlapGains`, `computeGainCompensation`, `applyVignettingCorrection`, `projectToCamera`, `renderBestPixelPanorama`, `_renderSkyReference`, `applySkyReference`, `computeImageAlignment`, `compileProgram`, `_erpCenterFromYawPitch`). Each file keeps a header naming its source.
