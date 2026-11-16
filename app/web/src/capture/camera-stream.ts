// Opens the rear camera for guided capture, preferring a 4:3 stream.
//
// A 16:9 stream is cropped from a phone sensor's narrow side. Held in portrait,
// that narrows the view across the frame: an iPhone's 16:9 Safari frames
// (1080 x 1920) fit about 37 x 62 degrees, too narrow for the 37-target pattern
// to overlap fully. A 4:3 stream uses the whole sensor, so it should be wider
// across the frame. Which formats a phone offers, and in which orientation the
// browser reports them, is not known in advance, so the requests are tried in
// order and what the camera actually delivered is recorded with every frame.
//
// VFTCam requests width 1920 / height 1080 (camera.js:51-57); 4:3 first is a
// product change. A room that already has frames keeps its first shape, because
// all 37 frames of a room must share one camera shape.

export type CameraStreamInfo = {
  /** Which request produced this stream (see CANDIDATES). */
  request: string;
  /** Size the browser reports for the track, and the frame shape it gives. */
  width: number | null; height: number | null; shape: string;
  frameRate: number | null; resizeMode: string | null; zoom: number | null; label: string | null;
  /** What the camera says it can do, where the browser reports it. */
  capabilities: { width: [number, number] | null; height: [number, number] | null; zoom: [number, number] | null; aspectRatio: [number, number] | null } | null;
};

type Candidate = { name: string; aspect: number; video: MediaTrackConstraints };
const rear = { facingMode: { ideal: 'environment' } } as const;
export const CANDIDATES: Candidate[] = [
  { name: '4:3 1920x1440', aspect: 4 / 3, video: { ...rear, width: { ideal: 1920 }, height: { ideal: 1440 } } },
  { name: '4:3 1440x1920', aspect: 4 / 3, video: { ...rear, width: { ideal: 1440 }, height: { ideal: 1920 } } },
  { name: '4:3 aspect', aspect: 4 / 3, video: { ...rear, aspectRatio: { ideal: 4 / 3 }, width: { ideal: 1920 } } },
  { name: '16:9 1920x1080', aspect: 16 / 9, video: { ...rear, width: { ideal: 1920 }, height: { ideal: 1080 } } },
];

/** Long side over short side, so portrait and landscape reports compare equal. */
export const shapeRatio = (width: number, height: number) => Math.max(width, height) / Math.min(width, height);
const sameShape = (a: number, b: number) => Math.abs(a - b) <= 0.02 * b;
export const shapeName = (width: number | null, height: number | null) => {
  if (!width || !height) return 'unknown';
  const ratio = shapeRatio(width, height);
  return sameShape(ratio, 4 / 3) ? '4:3' : sameShape(ratio, 16 / 9) ? '16:9' : `${ratio.toFixed(3)}:1`;
};

/** Requests to try, in order: the room's existing shape first if it has frames, else 4:3 first. */
export function candidatesFor(existing?: { width: number; height: number } | null): Candidate[] {
  if (!existing) return CANDIDATES;
  const ratio = shapeRatio(existing.width, existing.height);
  const matching = CANDIDATES.filter(c => sameShape(c.aspect, ratio));
  return matching.length ? matching : CANDIDATES;
}

const range = (value: unknown): [number, number] | null => {
  const r = value as { min?: number; max?: number } | undefined;
  return r && typeof r.min === 'number' && typeof r.max === 'number' ? [r.min, r.max] : null;
};

export function describeTrack(track: MediaStreamTrack, request: string): CameraStreamInfo {
  const s = track.getSettings() as MediaTrackSettings & { resizeMode?: string; zoom?: number };
  let capabilities: CameraStreamInfo['capabilities'] = null;
  try {
    const c = typeof track.getCapabilities === 'function' ? track.getCapabilities() as MediaTrackCapabilities & { zoom?: unknown } : null;
    if (c) capabilities = { width: range(c.width), height: range(c.height), zoom: range(c.zoom), aspectRatio: range(c.aspectRatio) };
  } catch { /* not reported by this browser */ }
  return {
    request, width: s.width ?? null, height: s.height ?? null, shape: shapeName(s.width ?? null, s.height ?? null),
    frameRate: s.frameRate ?? null, resizeMode: s.resizeMode ?? null, zoom: typeof s.zoom === 'number' ? s.zoom : null,
    // Phones report a name such as "Back Camera"; some browsers report a long opaque id instead.
    label: track.label ? track.label.slice(0, 60) : null, capabilities,
  };
}

/**
 * Opens the rear camera with the first request whose delivered shape matches
 * what it asked for; if none matches, keeps the last stream that opened.
 * `onTry` reports each attempt (for the capture screen).
 */
export async function openRearCamera(existing?: { width: number; height: number } | null): Promise<{ stream: MediaStream; info: CameraStreamInfo; tried: string[] }> {
  const tried: string[] = [];
  let fallback: { stream: MediaStream; info: CameraStreamInfo } | null = null, lastError: unknown = null;
  for (const candidate of candidatesFor(existing)) {
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: candidate.video }); }
    catch (error) {
      lastError = error; tried.push(`${candidate.name}: ${error instanceof DOMException ? error.name : 'failed'}`);
      // A denied permission will not change with another request.
      if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) break;
      continue;
    }
    const info = describeTrack(stream.getVideoTracks()[0], candidate.name);
    tried.push(`${candidate.name}: ${info.width ?? '?'} x ${info.height ?? '?'} (${info.shape})`);
    const ok = info.width && info.height && sameShape(shapeRatio(info.width, info.height), candidate.aspect)
      && (!existing || sameShape(shapeRatio(info.width, info.height), shapeRatio(existing.width, existing.height)));
    if (ok) { fallback?.stream.getTracks().forEach(t => t.stop()); return { stream, info, tried }; }
    fallback?.stream.getTracks().forEach(t => t.stop());
    fallback = { stream, info };
  }
  if (fallback) return { ...fallback, tried };
  throw lastError ?? new Error('The rear camera could not be opened.');
}
