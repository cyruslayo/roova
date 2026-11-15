import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { TARGETS, poseFromQuaternion } from './core';
import { VftcamStitcher } from './vftcam/stitcher.js';

// End-to-end geometry check of the shipped projection: a known point in a
// captured (y-down) image -> world direction from the capture quaternion ->
// the ERP pixel where PanoramaViewer displays that direction -> the stitcher's
// own projection back into the frame. A flip, mirror or roll-sign error moves
// off-center points to the wrong place, while the image center still passes.
const stitcher = new VftcamStitcher();
const D = Math.PI / 180;

function captureQuaternion(yaw: number, pitch: number, roll: number) {
  // A rear camera looks along local -Z; yaw 0 faces +Z, as in nearestTarget().
  return new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI + yaw * D)
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch * D))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), roll * D));
}

// PanoramaViewer: SphereGeometry scaled by (-1,1,1), so ERP column u shows
// direction (cos 2πu, ·, sin 2πu) and image row v = acos(y)/π (top = up).
function viewerErp(d: Vector3) {
  const u = ((Math.atan2(d.z, d.x) / (2 * Math.PI)) % 1 + 1) % 1;
  return { u, v: Math.acos(Math.max(-1, Math.min(1, d.y))) / Math.PI };
}

// The stitch shader's ERP direction for the same output pixel (its longitude
// origin is a quarter turn from the viewer's; that is a yaw offset, not a mirror).
function shaderDirection(erp: { u: number; v: number }) {
  const uvX = erp.u + 0.25, uvY = 1 - erp.v; // GL rows are bottom-up before the readback flip
  const lon = 2 * Math.PI * uvX - Math.PI, lat = Math.PI * (0.5 - uvY);
  return { x: Math.cos(lat) * Math.sin(lon), y: Math.sin(lat), z: Math.cos(lat) * Math.cos(lon) };
}

const imagePoints = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.2, 0.15], [0.8, 0.15], [0.2, 0.85], [0.8, 0.85], [0.35, 0.6]];

describe('capture pose to stitch projection', () => {
  for (const aspect of [16 / 9, 4 / 3]) for (const roll of [0, 5, -5]) {
    it(`maps asymmetric points back to their source pixel for all 37 targets (aspect ${aspect.toFixed(2)}, roll ${roll}°)`, () => {
      const tanH = Math.tan(43.2 * D / 2), tanV = tanH * aspect;
      let checked = 0;
      for (const target of TARGETS) {
        const q = captureQuaternion(target.yaw, target.pitch, roll);
        const pose = poseFromQuaternion(q);
        expect(pose).not.toBeNull();
        for (const [u, v] of imagePoints) {
          const world = new Vector3((2 * u - 1) * tanH, -(2 * v - 1) * tanV, -1).normalize().applyQuaternion(q);
          const projected = stitcher.projectToCamera(shaderDirection(viewerErp(world)), pose!, tanH, tanV);
          expect(projected, `target ${target.id} point ${u},${v}`).not.toBeNull();
          expect(projected!.u).toBeCloseTo(u, 4);
          expect(projected!.v).toBeCloseTo(v, 4);
          checked++;
        }
      }
      expect(checked).toBe(370);
    });
  }
});
