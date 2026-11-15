# Product definition and decisions

## Final v1 positioning
A **video-to-3D property room publishing platform**. A videographer provides a prepared room recording. The operator selects the video and ideally does nothing technical. The system validates and technically transcodes the **complete** submitted clip when necessary, submits to World Labs, collects a generated scene, and gives the operator an approval screen. On approval the operator publishes a shareable link. Visitors see the real room on mobile and can optionally explore its reconstructed 3D scene.

### Operator journey
1. Create a one-room tour (short title and optional property metadata).
2. Select the **final videographer-prepared room video** (may be large because of bitrate).
3. Observe honest upload/processing states; recover failed transfers.
4. Review a generated reconstruction against the source (mandatory because geometry may be invented).
5. Approve and publish a permanent URL.

### Visitor journey
1. Open public `/t/:slug` with no sign-in.
2. See a poster before any GPU/3D code loads.
3. Tap `Explore in 3D` if desired.
4. Pan/zoom/reset with clear conventional controls.
5. Return to photo/panorama on failure or by choice; share the link.

## Things explicitly deferred
- Video trimming, automatic best-interval selection, editing UI, and timeline controls. Videographers deliver complete finished clips.
- General-purpose 3D editor, creative keyframe timeline, 3D modeling and scene stitching.
- Whole-property continuous navigation and floor-plan editor.
- AI property guide, smart camera route/narration, branded MP4, analytics dashboard beyond basic events.
- Automatic claims about accurate dimensions or verified amenities.
- User-authenticated public viewing; visitor login is not needed.

## Future features agreed before scope reduction
- AI tour guide answering questions from **verified or attributed property records**, with actions to navigate rooms.
- Smart guided tour with deterministic camera templates and AI-drafted narration.
- Agency branding and share exports; floor-plan navigation; tour engagement analytics.
These are extensions, not a reason to delay the single-room product.

## Design values
- Follow Human Interface Design principles: direct manipulation, visible system status, familiar controls, recoverable errors, progressive disclosure, and respect for device/network limits.
- No blank loading canvas or fake percentage. The poster is useful content.
- 3D is enhancement, not a condition for opening a property page.
- Minimize operator decisions: no editorial selection at all. Reject unsuitable content, do not trim or choose a better section. Technical encoding can run automatically.

## Non-functional goals (targets, NOT verified measurements)
- Mobile Web Vitals: LCP <=2.5s, INP <=200ms, CLS <=0.1 (p75).
- First useful interactive 3D frame: <=6s on a target mid-range phone at 5 Mbps (after Explore).
- Active interaction target >=30fps on supported reference devices.
- Public tour should remain viewable with World Labs API unavailable.

## Fundamental decision
Capture quality must be measured before charging for reconstruction. No model can recover completely unseen surfaces reliably. The platform must not claim photographic/measured reality from an AI-generated scene without review.
