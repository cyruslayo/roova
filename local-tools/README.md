# Local RESEARCH video preparation helper (not a product feature)

Use this on Windows PowerShell, Linux, or macOS. Requires **Node.js 20+**, **FFmpeg**, and **FFprobe** on `PATH`.

This tool never uploads a file, contacts World Labs, or modifies the original video. It is solely for preparing the unedited DL3DV benchmark recording. **Do not add trim or best-segment selection to the product UI.** The videographer delivers a finished clip; the platform may transcode the entire clip without changing content.

## Inspect the 390 MB video

```powershell
node .\local-tools\video-prep.mjs --input "C:\Videos\dl3dv-video.mp4" --inspect
```

Inspect the source in a video player, find a steady continuous 20–30-second section with good overlapping room coverage, then prepare it:

```powershell
node .\local-tools\video-prep.mjs --input "C:\Videos\dl3dv-video.mp4" --prepare --start 15 --duration 25 --output ".\prepared\room-marble.mp4"
```

**15 seconds is an example, not an automatically chosen optimal start time.** Use the actual segment you inspect. The helper converts to H.264 MP4, max 1080p and 30 fps, removes audio, and targets <=95 MB through up to three encoding attempts. It writes a JSON report next to the output file.

### Before paid submission

1. Check whether the footage license allows this test, particularly for commercial projects.
2. Review the prepared clip in a player. Confirm the room coverage still makes sense.
3. Run the M1 harness mock tests.
4. Set the API key only in the terminal.
5. Use `--confirm-paid` only when ready to spend credits.

See `../code/property-tour-worldlabs-m1/README.md` for submission instructions.

## Why local preparation now but server processing later?

The first milestone has no cloud processing infrastructure. Local FFmpeg is the least expensive way to validate the media-processing contract. The production UI should not expose CLI commands or require users to install FFmpeg. A future processing worker will handle uploads after transfer to R2. On weak networks, avoiding a 390 MB transfer remains an unsolved usability problem; benchmark optional client-side compression before committing to it.
