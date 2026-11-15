import { Quaternion } from 'three';
import { TARGETS, poseFromQuaternion } from './core';
import type { SavedFrame } from './storage';
import { VftcamStitcher, type StitchLayer } from './vftcam/stitcher.js';
import FovCalibrator from './vftcam/fov-calibrator.js';
import { fillPolesSimple } from './vftcam/pole-fill-simple.js';

export const PANORAMA_WIDTH = 4096, PANORAMA_HEIGHT = 2048;
type Progress = (percent: number, message: string) => void;

// VFTCam's indoor baseline: 43.2° across the short side of a 9:16 portrait
// frame, so 70.28° along its long side. Phone cameras crop the short side of
// the sensor for other aspect ratios, so the long-side FOV is the prior that
// carries across aspects; the short side follows from the frame's real ratio.
const BASE_SHORT_FOV_9_16 = 43.2;
const BASE_LONG_TAN = Math.tan(BASE_SHORT_FOV_9_16 * Math.PI / 360) * 16 / 9;
const deg = (tan: number) => 2 * Math.atan(tan) * 180 / Math.PI;

export type StitchStage = { name: string; status: 'applied' | 'fallback' | 'skipped'; detail: string };
export type StitchResult = {
  blob: Blob; width: number; height: number;
  frameSize: { width: number; height: number }; sourceSize: { width: number; height: number };
  fov: { horizontal: number; vertical: number; calibrated: boolean };
  stages: StitchStage[];
};

export function requireCompleteRoom(frames: SavedFrame[]) {
  const ids = new Set(frames.map(frame => frame.targetId));
  const missing = TARGETS.filter(target => !ids.has(target.id)).map(target => target.id);
  if (frames.length !== 37 || ids.size !== 37 || missing.length) throw new Error(`All 37 distinct images are required. Missing targets: ${missing.join(', ') || 'check for duplicates'}.`);
  for (const frame of frames) {
    if (frame.imageBlob.type !== 'image/jpeg' || !frame.imageBlob.size || !frame.width || !frame.height || !Number.isFinite(frame.pose.yaw) || !Number.isFinite(frame.pose.pitch))
      throw new Error(`Target ${frame.targetId} has an invalid image or pose. Restore this frame before stitching.`);
  }
}

/** Working size for one frame: the source aspect exactly, long side capped as in VFTCam (720p on iOS, 1080p elsewhere). */
export function workingFrameSize(width: number, height: number, longCap: number) {
  const long = Math.max(width, height), scale = Math.min(1, longCap / long);
  const even = (value: number) => Math.max(2, 2 * Math.round(value * scale / 2));
  return { width: even(width), height: even(height) };
}

/** Field of view for the stitch shader, derived from the frames' real aspect ratio (height / width). */
export function baselineFov(width: number, height: number) {
  const longTan = BASE_LONG_TAN, shortTan = longTan * Math.min(width, height) / Math.max(width, height);
  return width <= height ? { horizontal: deg(shortTan), vertical: deg(longTan) } : { horizontal: deg(longTan), vertical: deg(shortTan) };
}

/** Pose for the stitcher: VFTCam re-derives yaw, pitch and roll from the full capture quaternion. */
export function stitchPose(frame: SavedFrame) {
  const [x, y, z, w] = frame.pose.orientationQuaternion ?? [];
  const q = [x, y, z, w].every(Number.isFinite) ? new Quaternion(x, y, z, w) : null;
  const measured = q && q.length() > 1e-8 ? poseFromQuaternion(q.normalize()) : null;
  return measured ? { yaw: measured.yaw, pitch: measured.pitch, roll: measured.roll, hasFullOrientation: true }
    : { yaw: ((frame.pose.yaw % 360) + 360) % 360, pitch: frame.pose.pitch, roll: frame.pose.roll || 0, hasFullOrientation: false };
}

const isIOS = () => typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

type Decoded = { pixels: Uint8ClampedArray; worker: Worker | null; sourceWidth: number; sourceHeight: number };

// Copies the stored frame into memory. Safari can fail to read IndexedDB-backed
// blobs through createImageBitmap ("An error occurred reading the Blob argument")
// or after they are posted to a worker; an in-memory copy avoids both.
async function frameBytes(frame: SavedFrame): Promise<Blob> {
  try { return new Blob([await frame.imageBlob.arrayBuffer()], { type: frame.imageBlob.type || 'image/jpeg' }); }
  catch { throw new Error(`The saved image for target ${frame.targetId} cannot be read from this browser's storage. Recapture target ${frame.targetId}; the other saved frames are kept.`); }
}

async function imageElement(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image(); image.src = url; await image.decode(); return image;
  } finally { URL.revokeObjectURL(url); }
}

function draw(source: CanvasImageSource, width: number, height: number): Uint8ClampedArray {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) throw new Error('Cannot prepare camera images.');
  ctx.drawImage(source, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  canvas.width = canvas.height = 1;
  return pixels;
}

async function decode(frame: SavedFrame, width: number, height: number, worker: Worker | null): Promise<Decoded> {
  const blob = await frameBytes(frame);
  if (worker) {
    const active = worker;
    try {
      const data = await new Promise<{ pixels: ArrayBuffer; sourceWidth: number; sourceHeight: number }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Worker timed out')), 15000);
        active.onmessage = event => { if (event.data.id !== frame.targetId) return; clearTimeout(timeout); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data); };
        active.onerror = () => { clearTimeout(timeout); reject(new Error('Worker preparation failed')); };
        active.postMessage({ id: frame.targetId, image: blob, width, height });
      });
      return { pixels: new Uint8ClampedArray(data.pixels), worker, sourceWidth: data.sourceWidth, sourceHeight: data.sourceHeight };
    } catch { worker.terminate(); worker = null; }
  }
  // Main-thread fallback: an <img> element, as the earlier product path and VFTCam's
  // fallback did; createImageBitmap is only a last resort.
  try {
    const image = await imageElement(blob);
    return { pixels: draw(image, width, height), worker, sourceWidth: image.naturalWidth, sourceHeight: image.naturalHeight };
  } catch (imageError) {
    try {
      const bitmap = await createImageBitmap(blob);
      try { return { pixels: draw(bitmap, width, height), worker, sourceWidth: bitmap.width, sourceHeight: bitmap.height }; }
      finally { bitmap.close(); }
    } catch {
      throw new Error(`The saved image for target ${frame.targetId} could not be decoded (${imageError instanceof Error ? imageError.message : 'unknown error'}). Recapture target ${frame.targetId}; the other saved frames are kept.`);
    }
  }
}

// The product stitch path: VFTCam's WebGL2 best-pixel pipeline (renderBestPixelPanorama
// with image alignment, focal refinement, local warps, overlap exposure, vignetting,
// routed seams, pole fill and sky reference). Never VFTCam's OpenCV startStitching route.
export async function stitchRoom(frames: SavedFrame[], progress: Progress): Promise<StitchResult> {
  requireCompleteRoom(frames);
  const sorted = [...frames].sort((a, b) => a.targetId - b.targetId);
  const first = sorted[0];
  const size = workingFrameSize(first.width, first.height, isIOS() ? 1280 : 1920);
  const aspect = first.height / first.width;
  for (const frame of sorted) if (Math.abs(frame.height / frame.width - aspect) > 0.01 * aspect)
    throw new Error(`Target ${frame.targetId} is ${frame.width} × ${frame.height}, but target ${first.targetId} is ${first.width} × ${first.height}. All 37 frames must share one camera shape; recapture this target.`);

  let worker: Worker | null = null;
  try { if (typeof OffscreenCanvas !== 'undefined') worker = new Worker(new URL('./stitch-worker.ts', import.meta.url), { type: 'module' }); } catch { /* main-thread fallback */ }
  const layers: StitchLayer[] = [];
  const erp = document.createElement('canvas'); erp.width = PANORAMA_WIDTH; erp.height = PANORAMA_HEIGHT;
  let gl: WebGL2RenderingContext | null = null;
  try {
    for (const [index, frame] of sorted.entries()) {
      progress(Math.floor(index / 37 * 40), `Preparing frame ${index + 1} of 37`);
      const decoded = await decode(frame, size.width, size.height, worker);
      worker = decoded.worker;
      // A decoded size other than the recorded one would mean the stored metadata is wrong; never stretch silently.
      if (Math.abs(decoded.sourceHeight / decoded.sourceWidth - aspect) > 0.01 * aspect)
        throw new Error(`Target ${frame.targetId} decoded as ${decoded.sourceWidth} × ${decoded.sourceHeight}, not ${frame.width} × ${frame.height}. Recapture this target.`);
      const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) throw new Error('Cannot prepare camera images.');
      ctx.putImageData(new ImageData(decoded.pixels, size.width, size.height), 0, 0);
      layers.push({ name: `hotspot_${frame.targetId}`, hotspotId: frame.targetId, canvas, ...stitchPose(frame) });
      if (index % 3 === 2) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    worker?.terminate(); worker = null;
    if (layers.length !== 37) throw new Error(`Only ${layers.length} of 37 frames were prepared. Source images remain saved.`);
    // Same ordering as VFTCam performBestPixelStitching.
    layers.sort((a, b) => (b.pitch - a.pitch) || (a.yaw - b.yaw));

    progress(42, 'Calibrating camera field of view from overlaps');
    const base = baselineFov(size.width, size.height);
    const stages: StitchStage[] = [];
    let fov = { ...base, calibrated: false };
    try {
      const captures = new Map(layers.map(layer => [layer.hotspotId, { imageData: layer.canvas, yaw: layer.yaw, pitch: layer.pitch, actualYaw: layer.yaw, actualPitch: layer.pitch, roll: layer.roll, width: size.width, height: size.height }]));
      // VFTCam indoor search: 41°–46° around 43.2° with a 43° prior, offset to this frame shape.
      const offset = base.horizontal - BASE_SHORT_FOV_9_16;
      const estimate = await FovCalibrator.calibrateFromCaptures(captures, { testFOVs: [41, 41.5, 42, 42.5, 43, 43.5, 44, 44.5, 45, 45.5, 46].map(f => f + offset), expectedFOV: 43 + offset, aspect: size.height / size.width });
      if (estimate) fov = { horizontal: estimate.horizontal, vertical: estimate.vertical, calibrated: true };
      stages.push(estimate ? { name: 'FOV calibration', status: 'applied', detail: `${estimate.horizontal.toFixed(1)}° × ${estimate.vertical.toFixed(1)}°` } : { name: 'FOV calibration', status: 'fallback', detail: `not enough overlap; baseline ${base.horizontal.toFixed(1)}° × ${base.vertical.toFixed(1)}°` });
    } catch (error) {
      stages.push({ name: 'FOV calibration', status: 'fallback', detail: `failed (${error instanceof Error ? error.message : 'unknown'}); baseline used` });
    }

    gl = erp.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, failIfMajorPerformanceCaveat: false });
    if (!gl) throw new Error('WebGL2 is required to stitch this room on this device. Source images remain saved.');
    const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number, maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (maxLayers < 40 || maxSize < PANORAMA_WIDTH) throw new Error(`This device cannot stitch a ${PANORAMA_WIDTH} × ${PANORAMA_HEIGHT} panorama in WebGL2. Source images remain saved.`);

    progress(50, 'Aligning views, matching exposure and routing seams');
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const stitcher = new VftcamStitcher();
    await stitcher.renderBestPixelPanorama(gl, erp, layers, fov, []);
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new Error('GPU stitch failed; your source frames are intact.');
    const log = stitcher._stitchLog;
    const entry = (prefix: string) => log.find(line => line.startsWith(prefix));
    const align = entry('align ');
    stages.push(align && !align.includes('not applied') ? { name: 'Image alignment, focal refinement and local warps', status: 'applied', detail: align.slice(6) } : { name: 'Image alignment', status: 'fallback', detail: 'not applied; sensor poses used' });
    for (const zenith of log.filter(line => line.startsWith('Zenith '))) stages.push({ name: 'Zenith orientation', status: zenith.includes('recovered') ? 'applied' : 'skipped', detail: zenith });
    const gains = entry('gains ');
    stages.push(gains ? { name: 'Overlap exposure gains', status: 'applied', detail: gains.slice(6) } : { name: 'Exposure gains', status: 'fallback', detail: 'whole-frame brightness fallback' });
    stages.push({ name: 'Vignetting correction', status: 'applied', detail: 'linear-light radial falloff, before upload' });
    const seams = entry('seams ');
    stages.push(seams ? { name: 'Seam routing', status: 'applied', detail: seams.slice(6) } : { name: 'Seam routing', status: 'fallback', detail: 'nearest-center seams' });
    layers.forEach(layer => { layer.canvas.width = layer.canvas.height = 0; });

    progress(80, 'Filling the floor and ceiling poles');
    try { fillPolesSimple(gl, erp, { nadirDeg: 0 }); stages.push({ name: 'Pole fill', status: 'applied', detail: 'coverage-aware push-pull fill' }); }
    catch (error) { stages.push({ name: 'Pole fill', status: 'fallback', detail: `failed (${error instanceof Error ? error.message : 'unknown'})` }); }

    const pixels = new Uint8Array(PANORAMA_WIDTH * PANORAMA_HEIGHT * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.finish();
    gl.readPixels(0, 0, PANORAMA_WIDTH, PANORAMA_HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Could not read the stitched image from the GPU.');
    gl.getExtension('WEBGL_lose_context')?.loseContext(); gl = null; erp.width = erp.height = 1;
    const rows = new Uint8ClampedArray(pixels.length), stride = PANORAMA_WIDTH * 4;
    for (let y = 0; y < PANORAMA_HEIGHT; y++) rows.set(pixels.subarray(y * stride, (y + 1) * stride), (PANORAMA_HEIGHT - 1 - y) * stride);
    const output = document.createElement('canvas'); output.width = PANORAMA_WIDTH; output.height = PANORAMA_HEIGHT;
    const context = output.getContext('2d'); if (!context) throw new Error('Could not encode the panorama.');
    context.putImageData(new ImageData(rows, PANORAMA_WIDTH, PANORAMA_HEIGHT), 0, 0);

    progress(86, 'Smoothing broad exposure steps');
    if (stitcher._skyReference) {
      try { stitcher.applySkyReference(output, stitcher._skyReference, 1); stages.push({ name: 'Broad tone reference', status: 'applied', detail: 'soft-average reference, 1.4° scale' }); }
      catch (error) { stages.push({ name: 'Broad tone reference', status: 'fallback', detail: `skipped (${error instanceof Error ? error.message : 'unknown'})` }); }
      stitcher._skyReference = null;
    } else stages.push({ name: 'Broad tone reference', status: 'skipped', detail: 'reference render unavailable' });

    progress(92, `Encoding ${PANORAMA_WIDTH} × ${PANORAMA_HEIGHT} panorama`);
    const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(result => result?.type === 'image/jpeg' ? resolve(result) : reject(new Error('JPEG encoding failed.')), 'image/jpeg', 0.9));
    output.width = output.height = 1;
    progress(100, 'Panorama ready');
    return { blob, width: PANORAMA_WIDTH, height: PANORAMA_HEIGHT, frameSize: size, sourceSize: { width: first.width, height: first.height }, fov, stages };
  } finally {
    worker?.terminate();
    layers.forEach(layer => { layer.canvas.width = layer.canvas.height = 0; });
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    erp.width = erp.height = 1;
  }
}
