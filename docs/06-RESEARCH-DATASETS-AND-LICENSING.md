# Sample footage research and rights

## Primary dataset: DL3DV-10K
- Official GitHub README: https://github.com/DL3DV-10K/Dataset
- Samples: https://huggingface.co/datasets/DL3DV/DL3DV-10K-Sample/tree/main
- One previously shared direct-file path: https://huggingface.co/datasets/DL3DV/DL3DV-10K-Sample/resolve/main/5c3af581028068a3c402c7cbe16ecf9471ddf2897c34ab634b7b1b6cf81aba00/video.mp4
- User said access was approved and one video downloaded to PC (~390 MB). **Not present in the archive** and frames not inspected here.
- Published capture guidance: 4K/30–60fps, >=180°/360° coverage at multiple heights, camera movement with overlapping views, little motion blur, moving objects minimized; source videos may exceed 60 seconds and require careful segment selection for Marble.
- Dataset GitHub `License.md` states **CC BY-NC 4.0** and specific terms restricting non-commercial research and education. Do not assume commercial product/public showcase rights. User approval to access dataset does not necessarily grant expanded licensing rights.

## Other references
- ScanNet++: https://github.com/scannetpp/scannetpp ; iPhone video, high-quality images and reference 3D geometry; useful for controlled reconstruction evaluation; check terms.
- Tanks and Temples: https://github.com/isl-org/TanksAndTemples and https://tanksandtemples.org/ ; benchmark videos (Meeting Room); separate data license.
- Meta VGGT sample inputs: https://github.com/facebookresearch/vggt/tree/main/examples/videos ; sample `room.mp4` and `kitchen.mp4` existed in prior research; check actual video frames/licenses before use.
- `room-splat` case study: https://github.com/Chen931222/room-splat ; real phone scan lessons and Spark viewer, but **original source recordings are not in GitHub**. High relevance for intake QA (lighting, exposure, mirrors, camera geometry), no immediate test footage.
- Mixkit stock: https://mixkit.co/free-stock-video/pan-shot-of-the-interior-of-a-hotel-room-4198/ ; already inspected and included as sample; unsuitable as final quality criterion.
- World Labs API reference: https://docs.worldlabs.ai/api/reference and OpenAPI https://docs.worldlabs.ai/api/reference/openapi.

## Quality evaluation proposal (not measured)
For each reconstructed sample, record a reviewer score across structural fidelity (25%), object fidelity (25%), unseen-view stability (20%), visual appearance (15%), tour usability (15%). Initial proposed threshold >=80/100 *and* no critical structural misrepresentation. Never confuse this rubric with a certified metric. Compare source frames and identical camera views where possible. Benchmark mobile separately.

## Source handling
Only reuse footage under its actual license. If the user wants a production commercial demo, record their own rights-cleared room video or obtain written rights from a provider. Avoid publishing private interiors or identifiable people in reconstructed mirrors.
