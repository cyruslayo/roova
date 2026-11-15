# Stillroom property panorama MVP

This repository contains the Stillroom application in `app/`, the VFTCam JavaScript source baseline, and a vertical-slice work plan. It is not a runnable copy of Stanford's site.

## Repository map

```text
AGENTS.md
README.md
START_HERE_PROMPT.md
THIRD_PARTY_NOTICES.md
docs/
  decisions.md
  source-map.md
  vertical-slices.md
reference/vftcam-js/
  source-manifest.json
  js/
  inline/
  service-worker.js
  sw.js
licenses/
app/
```

The `reference/vftcam-js` folder preserves the uploaded JavaScript snapshot. Build the product in the repository's normal application folders. Do not run the reference site as the product. Its HTML, CSS, icons, fonts, and example images are absent by design.

The user confirms permission to use and change the VFTCam application code for this project. Keep the permission record with the repository. The permission text is not in this package. Third-party JavaScript has separate licenses in `licenses/`.

## Vertical slice 1

Read `AGENTS.md`, `docs/vertical-slices.md`, and `app/web/README.md`. The capture page is available from Studio's selected tour or `/studio/capture/:tourId`. Its browser simulation results and unverified device checks are recorded in `docs/capture-checks.md`.

The active capture pattern has 37 targets. The earlier 36-target specification needs correction before implementation. Add the actual technical specification to `docs/spec/` when available. Do not treat this package as a substitute for that specification.

The reference ZIP contains 46 JavaScript files. All passed `node --check` during the source audit. Phone capture and WebGL stitching have not been verified.
