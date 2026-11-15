// Synthetic replay of the product stitch path. A procedural room with
// asymmetric, textured content is rendered into 37 perspective JPEG frames at
// the guided-capture poses (optionally with sensor-pose error), passed through
// stitchRoom() exactly as PanoramaRoom does, and the 4096 × 2048 output is
// compared with the ground truth at the direction PanoramaViewer shows.
// This exercises the GPU, worker, alignment, exposure, seams and pole fill,
// but it is not a phone or real-room result.
import { Quaternion, Vector3 } from 'three';
import { TARGETS, poseFromQuaternion } from '../src/capture/core';
import { stitchRoom } from '../src/capture/stitch';
import type { SavedFrame } from '../src/capture/storage';

const D = Math.PI / 180;
type Options = { simulateSafariBlobFailure?: boolean; width: number; height: number; shortFov: number; poseError: number; rollError: number; exposureJitter: number; seed: number };

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const hash = (a: number, b: number) => { const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return h - Math.floor(h); };

// Ground truth radiance for a world direction (THREE world, +Y up). Longitude
// hue, latitude bands, a hashed checker for corners, and one-sided markers so
// any flip, mirror or rotation is visible.
export function scene(d: Vector3): [number, number, number] {
  const lon = Math.atan2(d.x, d.z), lat = Math.asin(Math.max(-1, Math.min(1, d.y)));
  const cx = Math.floor((lon / D + 180) / 7.5), cy = Math.floor((lat / D + 90) / 7.5);
  const h = hash(cx, cy), check = (cx + cy) % 2 ? 1 : 0.72;
  const hue = (lon / D + 180) / 360;
  let r = 0.5 + 0.4 * Math.cos(2 * Math.PI * hue), g = 0.5 + 0.4 * Math.cos(2 * Math.PI * (hue - 1 / 3)), b = 0.5 + 0.4 * Math.cos(2 * Math.PI * (hue - 2 / 3));
  const shade = (0.45 + 0.35 * h) * check * (0.75 + 0.25 * Math.sin(lat));
  r *= shade; g *= shade; b *= shade;
  // Asymmetric "L" marker near each cell's lower-left corner.
  const fx = ((lon / D + 180) / 7.5) % 1, fy = ((lat / D + 90) / 7.5) % 1;
  if ((fx < 0.12 && fy < 0.55) || (fy < 0.12 && fx < 0.4)) { r = 0.95; g = 0.95; b = 0.9; }
  // Floor and ceiling tones so the poles carry content.
  if (lat < -60 * D) { r = 0.35 + 0.2 * h; g = 0.25 + 0.1 * h; b = 0.18; }
  if (lat > 70 * D) { r = g = b = 0.8 + 0.1 * h; }
  return [r, g, b];
}

const captureQuaternion = (yaw: number, pitch: number, roll: number) =>
  new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI + yaw * D)
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch * D))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), roll * D));

async function renderFrame(q: Quaternion, o: Options, gain: number): Promise<Blob> {
  const tanH = Math.tan(o.shortFov * D / 2) * (o.width <= o.height ? 1 : o.width / o.height);
  const tanV = tanH * o.height / o.width;
  const canvas = document.createElement('canvas'); canvas.width = o.width; canvas.height = o.height;
  const ctx = canvas.getContext('2d')!; const image = ctx.createImageData(o.width, o.height);
  const v = new Vector3();
  for (let y = 0; y < o.height; y++) for (let x = 0; x < o.width; x++) {
    v.set((2 * (x + 0.5) / o.width - 1) * tanH, -(2 * (y + 0.5) / o.height - 1) * tanV, -1).normalize().applyQuaternion(q);
    const c = scene(v), k = (y * o.width + x) * 4;
    image.data[k] = Math.min(255, 255 * c[0] * gain); image.data[k + 1] = Math.min(255, 255 * c[1] * gain); image.data[k + 2] = Math.min(255, 255 * c[2] * gain); image.data[k + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/jpeg', 0.9));
  canvas.width = canvas.height = 1;
  return blob;
}

async function run(partial: Partial<Options>) {
  const o: Options = { width: 720, height: 1280, shortFov: 43.2, poseError: 0, rollError: 0, exposureJitter: 0, seed: 7, ...partial };
  const random = rng(o.seed), noise = (amount: number) => (random() * 2 - 1) * amount;
  const frames: SavedFrame[] = [];
  for (const target of TARGETS) {
    const roll = noise(3);
    const truth = captureQuaternion(target.yaw + noise(1), target.pitch + noise(1), roll);
    const sensed = captureQuaternion(target.yaw + noise(o.poseError), target.pitch + noise(o.poseError), roll + noise(o.rollError));
    // The stitcher renders with the true pose but is told the sensed one.
    const rendered = captureQuaternion(0, 0, 0).copy(truth);
    const blob = await renderFrame(rendered, o, 1 + noise(o.exposureJitter));
    const pose = poseFromQuaternion(sensed)!;
    frames.push({ key: `replay:${target.id}`, roomId: 'replay', targetId: target.id, targetYaw: target.yaw, targetPitch: target.pitch, imageBlob: blob, width: o.width, height: o.height, timestamp: new Date().toISOString(), videoTime: 0, pose });
  }
  const t0 = performance.now(), stages: string[] = [];
  // Reproduces the Safari symptom: createImageBitmap(blob) rejects with
  // "An error occurred reading the Blob argument to createImageBitmap", and
  // no worker is available, so frames must decode through the <img> fallback.
  const realBitmap = window.createImageBitmap, realOffscreen = (window as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  if (o.simulateSafariBlobFailure) {
    (window as unknown as { createImageBitmap: unknown }).createImageBitmap = (source: unknown) => source instanceof Blob
      ? Promise.reject(new DOMException('An error occurred reading the Blob argument to createImageBitmap.', 'InvalidStateError')) : realBitmap.call(window, source as ImageBitmapSource);
    (window as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas = undefined;
  }
  let result: Awaited<ReturnType<typeof stitchRoom>>;
  try { result = await stitchRoom(frames, (_p, message) => { stages.push(message); }); }
  finally { window.createImageBitmap = realBitmap; (window as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas = realOffscreen; }
  const seconds = (performance.now() - t0) / 1000;
  const bitmap = await createImageBitmap(result.blob);
  const out = document.createElement('canvas'); out.width = bitmap.width; out.height = bitmap.height;
  const octx = out.getContext('2d', { willReadFrequently: true })!; octx.drawImage(bitmap, 0, 0);
  const data = octx.getImageData(0, 0, out.width, out.height).data;
  // Compare on a grid in the stitcher's ERP convention: column u is longitude
  // 2πu − π from +Z (THREE world X = −sin(lon)); PanoramaViewer shows the same
  // image a constant quarter turn in heading away, which is not a mirror.
  // The mirrored comparison is a control: a flipped stitch would score better there.
  const bands: Record<string, { err: number; n: number; good: number; black: number; mirrorErr: number }> = {};
  const d = new Vector3();
  for (let py = 4; py < out.height; py += 8) for (let px = 4; px < out.width; px += 8) {
    const u = (px + 0.5) / out.width, lat = Math.PI * (0.5 - (py + 0.5) / out.height), lon = 2 * Math.PI * u - Math.PI;
    const band = lat > 60 * D ? 'ceiling >60°' : lat > 20 * D ? 'upper 20–60°' : lat >= -20 * D ? 'equator ±20°' : lat >= -60 * D ? 'lower −20–−60°' : 'floor <−60°';
    const k = (py * out.width + px) * 4;
    const error = (truth: [number, number, number]) => (Math.abs(data[k] - 255 * truth[0]) + Math.abs(data[k + 1] - 255 * truth[1]) + Math.abs(data[k + 2] - 255 * truth[2])) / 3;
    const e = error(scene(d.set(-Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon))));
    const mirrored = error(scene(d.set(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon))));
    const s = bands[band] ??= { err: 0, n: 0, good: 0, black: 0, mirrorErr: 0 };
    s.err += e; s.mirrorErr += mirrored; s.n++; if (e < 20) s.good++; if (data[k] + data[k + 1] + data[k + 2] === 0) s.black++;
  }
  const summary = Object.fromEntries(Object.entries(bands).map(([name, s]) => [name, { meanAbsError: +(s.err / s.n).toFixed(1), mirroredControlError: +(s.mirrorErr / s.n).toFixed(1), within20: +(s.good / s.n).toFixed(3), black: +(s.black / s.n).toFixed(4) }]));
  const preview = document.createElement('canvas'); preview.width = 2048; preview.height = 1024;
  preview.getContext('2d')!.drawImage(bitmap, 0, 0, 2048, 1024);
  const previewUrl = preview.toDataURL('image/jpeg', 0.85);
  return { options: o, output: { width: bitmap.width, height: bitmap.height, bytes: result.blob.size }, seconds: +seconds.toFixed(1), frameSize: result.frameSize, fov: result.fov, stages: result.stages, summary, previewUrl };
}

(window as unknown as { runReplay: typeof run }).runReplay = run;
document.body.dataset.ready = '1';
