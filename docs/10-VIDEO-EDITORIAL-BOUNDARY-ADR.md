# ADR: Videographer owns the finished clip; the platform performs technical processing only

**Decision date:** 2026-11-13  
**Status:** Accepted, supersedes any earlier proposals for AI interval selection or an operator trim UI.

## Decision
- Videographer plans the shoot, selects a continuous recording, trims if needed, and delivers one **finished room video**.
- Operator selects the finished file and uploads. They do not select a segment, trim, or edit video.
- Platform validates video type, size, duration, encoding, and basic quality. It can transcode/compress **the entire clip** without changing its chronological content, speed, or framing.
- If footage needs editorial intervention (multiple rooms, cuts, excessive length, inadequate coverage), **reject it with clear redelivery guidance**. Never silently select the “best 25 seconds.”
- Continue with World Labs generation, fidelity review, and publication after successful validation.

## Handling oversized files
A 390 MB completed clip is not automatically invalid; the large size may be high bitrate. Upload directly to private storage, with multipart/resumable transfer when justified, and transcode the *entire* clip under the provider limit. A 390 MB unedited dataset recording, however, is not a customer-ready video and must be manually prepared **only as a research sample**.

## Product UX
One upload area. During processing, show honest states and a clear rejection reason when necessary. No editing timeline, best-clip suggestions, cut tools, or user-selectable FFmpeg options.

## Open research
The current World Labs prompt guidelines require a maximum 30-second video, and the API limits input to 100 MB. Establish videographer capture guidance within those limits by measuring uploaded bytes, compression quality, and reconstruction fidelity on real videos.

## Acceptance tests
1. A suitable under-limit clip passes without modification.
2. A suitable over-size clip is fully re-encoded with unchanged duration/content and passes provider file size checks.
3. A long unedited walkthrough fails with clear videographer instructions; no trim UI appears.
4. No recording is shortened or sped up without explicit *developer* action in research tooling.
5. The operator only reviews generated 3D output before publishing.
