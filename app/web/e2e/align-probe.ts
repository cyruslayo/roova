// Probe for direct alignment on an exported capture: decodes the ZIP's frames at the
// stitch working size, takes poses from stitchPose(), and runs directAlign() for each
// candidate field of view without stitching. Used to measure, not by the product.
import { readZip, type FrameExportManifest } from '../src/capture/export-frames';
import { stitchPose, workingFrameSize, baselineFov } from '../src/capture/stitch';
import { directAlign, type DirectAlignLayer } from '../src/capture/direct-align';
import type { SavedFrame } from '../src/capture/storage';

async function load(url: string, maxLongSide = 1280) {
  const files = readZip(await (await fetch(url)).arrayBuffer());
  const manifest = JSON.parse(new TextDecoder().decode(files.get('poses.json'))) as FrameExportManifest;
  const f0 = manifest.frames[0], size = workingFrameSize(f0.width, f0.height, maxLongSide);
  const layers: DirectAlignLayer[] = [];
  for (const f of manifest.frames) {
    const bitmap = await createImageBitmap(new Blob([files.get(f.file)!], { type: 'image/jpeg' }));
    const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, size.width, size.height); bitmap.close();
    const frame = { targetId: f.targetId, pose: { yaw: f.yaw, pitch: f.pitch, roll: f.roll, orientationQuaternion: f.orientationQuaternion } } as unknown as SavedFrame;
    layers.push({ hotspotId: f.targetId, canvas, ...stitchPose(frame) });
  }
  return { layers, size };
}

async function probe(url: string, shortFovs: number[]) {
  const { layers, size } = await load(url);
  const base = baselineFov(size.width, size.height), out = [];
  for (const h of shortFovs) {
    const copy = layers.map(l => ({ ...l }));
    const v = 2 * Math.atan(Math.tan(h * Math.PI / 360) * size.height / size.width) * 180 / Math.PI;
    const r = directAlign(copy, { horizontal: h, vertical: v });
    out.push({ fov: `${h.toFixed(1)} x ${v.toFixed(1)}`, ...r });
  }
  return { base, out };
}
async function poses(url: string) {
  const { layers } = await load(url);
  return layers.map(l => ({ id: l.hotspotId, yaw: l.yaw, pitch: l.pitch, roll: l.roll }));
}
(window as unknown as { probe: typeof probe; poses: typeof poses }).probe = probe;
(window as unknown as { poses: typeof poses }).poses = poses;
