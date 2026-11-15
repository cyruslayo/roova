# Mobile UX and rendering strategy

## Primary interface
See `design/property-tour-mobile-prototype.html` and `design/property-tour-mobile-ux-spec.md`. The HTML is an interactive UX demonstration, not an actual SPZ renderer. Do not confuse UI simulation with 3D performance verification.

### Screen states
- **Preview:** eagerly rendered approved poster, room title, Share, `Explore in 3D`. No WebGL download required.
- **Loading:** keep poster visible, show honest activity, allow `View photo instead`.
- **3D:** user controls look/orbit, pinch zoom, reset and full-screen. No automatic camera movement.
- **Fallback:** show panorama/photo, preserve room metadata and share link, explain that 3D is unavailable or paused.

### Human Interface Design principles
- The property is content; rendering technology stays invisible.
- Direct manipulation and recoverable mistakes. Never trap the viewer in an unfamiliar 3D mode.
- Respect device constraints, touch target >=44 CSS px, safe areas, and `prefers-reduced-motion`.
- In-browser controls must work in portrait; don't force landscape or visitor sign-in.
- Always render a useful first screen before loading large modules.

## Initial 3D technical choices
- Spark 2.x + Three.js is the provisional primary candidate. Native SPZ, potential LoD/RAD and on-demand frames.
- PlayCanvas SuperSplat/SOG is the comparison candidate, not a mandatory part of v1.
- **Do not** add offline RAD generation before measuring direct 100k/500k SPZ delivery on actual devices.
- Store World Labs spatial `metric_scale_factor` and `ground_plane_offset`, and handle orientation in a verified renderer adapter.
- Disable unnecessary postprocessing and costly MSAA. Dynamically scale render resolution on constrained phones.
- Stop unnecessary rendering when stationary and release GPU resources on scene changes.
- Lazy-load all heavy 3D modules on user intent. Cache immutable assets via CDN.

## Targets (proposed; not yet measured)
| Metric | Gate |
|---|---|
| LCP | <=2.5s (mobile p75) |
| INP | <=200ms (mobile p75) |
| CLS | <=0.1 (mobile p75) |
| First interactive scene | <=6s after Explore at 5 Mbps on test device |
| 3D active navigation | >=30fps on supported Android/iPhone |
| Failure behavior | Photograph/panorama remains usable with zero World Labs calls |

Test on low-cost Android, mid-range Android, old iPhone, new iPhone; Chrome, Safari, WhatsApp/in-app browsers; constrained 4G and flaky networks. Report transferred bytes, first frame time, median/p95 frame time, memory pressure and context loss.

## Renderer selection procedure
Use one real Marble reconstruction with saved 100k,500k,full_res SPZ if available. Compare Spark direct SPZ with Spark RAD streaming; add SuperSplat SOG when meaningful. Score visual fidelity *and* speed. Adopt the least complex renderer meeting mobile quality criteria.

## Risk
AI reconstruction may invent surfaces not shown in video. The public UI must label the tour appropriately, avoid presenting room dimensions as measurements, and ensure an operator approved the scene.
