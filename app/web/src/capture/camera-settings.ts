// Per-device camera settings for stitching, after VFTCam's field-of-view
// fine-tuning card (card-ui.js:209-248, 1044-1145), its indoor/outdoor capture
// mode (capture.js:600-660) and its tripod switch (app.js:2078). They are a
// property of this phone's camera, so they live in this browser only.
//
// Precedence, as in VFTCam's performBestPixelStitching (app.js:1922-1972):
//   1. a developer override (sessionStorage overrideFOV / overrideVFOV);
//   2. saved offsets for the current mode, when either is non-zero: the mode's
//      base plus the offsets, and calibration is skipped;
//   3. otherwise automatic calibration, falling back to the mode's base.
//
// Deviation from VFTCam: offsets range +-10 degrees instead of +-5, because a
// measured iPhone Safari stream (about 37 x 62 degrees) sits below VFTCam's
// lowest setting (38.2 degrees).

export type CaptureMode = 'indoor' | 'outdoor';
export type FovOffsets = { horizontal: number; vertical: number };
export type CameraSettings = { mode: CaptureMode; offsets: Record<CaptureMode, FovOffsets>; tripod: boolean };
export type Fov = { horizontal: number; vertical: number };

export const OFFSET_LIMIT = 10, OFFSET_STEP = 0.5;
const STORAGE_KEY = 'stillroom.cameraSettings.v1';

export const defaultCameraSettings = (): CameraSettings => ({
  mode: 'indoor', tripod: false,
  offsets: { indoor: { horizontal: 0, vertical: 0 }, outdoor: { horizontal: 0, vertical: 0 } },
});

const clampOffset = (value: unknown) => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, Math.round(n / OFFSET_STEP) * OFFSET_STEP));
};

export function normalizeCameraSettings(raw: unknown): CameraSettings {
  const base = defaultCameraSettings();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<CameraSettings> & { offsets?: Partial<Record<CaptureMode, Partial<FovOffsets>>> };
  const offsets = (mode: CaptureMode): FovOffsets => ({ horizontal: clampOffset(r.offsets?.[mode]?.horizontal), vertical: clampOffset(r.offsets?.[mode]?.vertical) });
  return { mode: r.mode === 'outdoor' ? 'outdoor' : 'indoor', tripod: r.tripod === true, offsets: { indoor: offsets('indoor'), outdoor: offsets('outdoor') } };
}

export function loadCameraSettings(): CameraSettings {
  try { return normalizeCameraSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')); }
  catch { return defaultCameraSettings(); }
}

export function saveCameraSettings(settings: CameraSettings): boolean {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeCameraSettings(settings))); return true; }
  catch { return false; }
}

const D = Math.PI / 180;
const deg = (tan: number) => 2 * Math.atan(tan) / D;
const tanHalf = (degrees: number) => Math.tan(degrees * D / 2);
const isNineBySixteen = (width: number, height: number) => Math.abs(Math.max(width, height) / Math.min(width, height) - 16 / 9) < 0.01;

/**
 * The mode's base field of view for frames of this shape ("horizontal" is the
 * image x axis, as in the stitch shader). VFTCam: indoor 43.2 x 70.28 degrees
 * (vertical derived for 9:16), outdoor 45.7 x 73.3 (both fixed). For other
 * shapes the long side keeps the mode's value and the short side follows the
 * real aspect ratio, as the product's indoor baseline already does.
 */
export function modeBaseFov(width: number, height: number, mode: CaptureMode): Fov {
  const portrait = width <= height, ratio = Math.min(width, height) / Math.max(width, height);
  let shortDeg: number, longDeg: number;
  if (mode === 'outdoor') {
    longDeg = 73.3;
    shortDeg = isNineBySixteen(width, height) ? 45.7 : deg(tanHalf(longDeg) * ratio);
  } else {
    const longTan = tanHalf(43.2) * 16 / 9;
    longDeg = deg(longTan); shortDeg = deg(longTan * ratio);
  }
  return portrait ? { horizontal: shortDeg, vertical: longDeg } : { horizontal: longDeg, vertical: shortDeg };
}

export type FovPlan =
  | { source: 'override'; fov: Fov; base: Fov }
  | { source: 'manual'; fov: Fov; base: Fov; offsets: FovOffsets }
  | { source: 'calibrate'; base: Fov };

/** Which field of view the stitch uses, in VFTCam's order. `override` is VFTCam's sessionStorage overrideFOV / overrideVFOV. */
export function planFov(width: number, height: number, settings: CameraSettings, override?: { horizontal?: number | null; vertical?: number | null }): FovPlan {
  const base = modeBaseFov(width, height, settings.mode);
  const oh = override?.horizontal;
  if (typeof oh === 'number' && Number.isFinite(oh) && oh > 10 && oh < 170) {
    const ov = override?.vertical;
    // VFTCam derives the vertical from the horizontal with the frame aspect when only H is set.
    const vertical = typeof ov === 'number' && Number.isFinite(ov) && ov > 10 && ov < 170 ? ov : deg(tanHalf(oh) * height / width);
    return { source: 'override', fov: { horizontal: oh, vertical }, base };
  }
  const offsets = settings.offsets[settings.mode];
  if (offsets.horizontal !== 0 || offsets.vertical !== 0)
    return { source: 'manual', fov: { horizontal: base.horizontal + offsets.horizontal, vertical: base.vertical + offsets.vertical }, base, offsets };
  return { source: 'calibrate', base };
}

/** VFTCam's developer override, read from this tab's sessionStorage (console only). */
export function readFovOverride(): { horizontal: number | null; vertical: number | null } {
  try {
    const h = sessionStorage.getItem('overrideFOV'), v = sessionStorage.getItem('overrideVFOV');
    return { horizontal: h === null ? null : parseFloat(h), vertical: v === null ? null : parseFloat(v) };
  } catch { return { horizontal: null, vertical: null }; }
}

/** VFTCam's tripod setting widens the nadir fill to 22 degrees (app.js:2078). */
export const nadirFillDegrees = (settings: CameraSettings) => (settings.tripod ? 22 : 0);
