# Open engineering questions and risks

1. **Real input compatibility:** Does the user-selected DL3DV 25–30-second continuous segment yield a faithful scene in Marble? This is untested.
2. **Model duration:** The OpenAPI schema declares a 100 MB video ceiling but no universal hard 30-second limit. Confirm latest capture guidance and behavior before enforcement.
3. **Streaming upload:** Is World Labs signed media upload compatible with R2->World Labs streaming in Cloudflare Workers? Baseline M1 CLI performs direct local upload, not Worker streaming.
4. **URI shortcut:** Video prompt can use `source:"uri"`; whether a temporary R2 signed URL remains accessible for the provider's fetch behavior must be tested. Not the baseline.
5. **Cloudflare processing:** Workers cannot run arbitrary heavy FFmpeg native processes. A small CPU job runner/container will likely be required for server transcoding; choose minimal operational burden.
6. **Largest bottleneck:** Uploading 390 MB across weak networks is still costly even when server transcoding succeeds. Test actual mobile upload. Browser-side precompression is optional R&D, not a promised feature.
7. **Editorial scope locked:** No automatic interval selection or operator trim UI. Videographers must deliver ready-to-submit, continuous room clips. Local interval selection exists solely to prepare this non-production DL3DV research recording.
8. **Privacy:** Original private property footage, identifiable people, mirrors, and tenant data require clear permissions, access controls and deletion rules.
9. **Reconstruction fidelity:** Generate with a private provider world; operator must approve image/geometry before publishing. Never invent dimensions.
10. **Provider credit safety:** Handle uncertain paid POST with reconciliation. No automatic duplicate submissions.
11. **Asset size:** SPZ resolution keys and output fields are optional. Need actual provider asset sizes and expiry behavior.
12. **Mobile rendering:** Spark versus SuperSplat remains a provisional choice. Real-device benchmarks needed. Some phones may require fallback.
13. **Business/legal:** DL3DV dataset is CC BY-NC with separate research terms; the approved download is not proof of permission for commercial/public distribution.
14. **Vendor dependence:** World Labs reconstruction and Cloudflare hosting are dependencies; export and retain source media, provider-neutral assets, SQLite-compatible data.
15. **Current package:** There is no generated API key, active user session, deployed URL or raw OpenAPI specification included. Don't claim otherwise.
