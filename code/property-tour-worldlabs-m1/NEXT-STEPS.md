# After M1 succeeds

1. Confirm the World Labs output is visually faithful. Record missing objects, artifacts, rendering orientation, and acceptable camera limits.
2. Copy the provider-neutral `WorldLabsClient` into the Cloudflare Worker project.
3. Replace local file I/O with **private R2** source uploads and **versioned delivery assets**.
4. Use D1 to store one state record per paid generation. Add a uniqueness guard on `operation_id` and a `start_uncertain` recovery workflow.
5. Introduce Cloudflare Workflows for polling and collection. Enforce the provider's *account-wide* start limits before new submissions.
6. Implement the mobile viewer using 100k SPZ first and panorama/poster fallback.
7. Publish only after operator approval. Keep stable `/t/:slug` URLs pointing to an approved scene version.
8. Test actual 4G first-interactive time and 30fps during movement on budget Android and an older iPhone. Add RAD LoD only if benchmarks support it.

## Open decisions

- Do signed World Labs asset URLs allow direct download of all outputs before expiration?
- Does transferring from Cloudflare R2 to World Labs signed upload work through Worker streaming under real network constraints?
- Is URI video input with time-limited R2 signed URLs supported in practice?
- What scene sizes, RAM usage, and mobile frame times do we observe for the representative room?

## Source references

- https://docs.worldlabs.ai/api/reference/openapi
- https://docs.worldlabs.ai/api/reference/media-assets/prepare-upload
- https://docs.worldlabs.ai/api/reference/worlds/generate
- https://docs.worldlabs.ai/api/reference/operations/get
- https://docs.worldlabs.ai/api/reference/worlds/get
- https://docs.worldlabs.ai/api/rate-limits
