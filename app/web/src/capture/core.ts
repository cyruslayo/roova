import { Euler, Quaternion, Vector3 } from 'three';

// Adapted from VFTCam hotspots.js, scene.js and capture-orientation.js.
export const APPROACH_THRESHOLD = 0.25;
export const ALIGNMENT_THRESHOLD = 0.08;
export const CAPTURE_HOLD_MS = 1000;
export const LEVEL_TOLERANCE = 8;
export type Target = { id: number; yaw: number; pitch: number };
export const TARGETS: Target[] = [45, 0, -45].flatMap((pitch, row) =>
  Array.from({ length: 12 }, (_, index) => ({ id: row * 12 + index + 1, yaw: index * 30, pitch }))
).concat({ id: 37, yaw: 0, pitch: 84 });

export type Pose = { yaw: number; pitch: number; roll: number; orientationQuaternion: [number, number, number, number] };

export function orientationQuaternion(alpha: number, beta: number, gamma: number): Quaternion {
  // Preserve the VFTCam YXZ conversion and portrait-phone camera rotation.
  const quaternion = new Quaternion().setFromEuler(new Euler(beta * Math.PI / 180, alpha * Math.PI / 180, -gamma * Math.PI / 180, 'YXZ'));
  return quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2));
}

export function poseFromQuaternion(q: Quaternion): Pose | null {
  const values = q.toArray() as [number, number, number, number];
  if (!values.every(Number.isFinite)) return null;
  const [x, y, z, w] = values;
  const right = [1 - 2 * (y*y + z*z), 2 * (x*y + z*w), 2 * (x*z - y*w)];
  const up = [2 * (x*y - z*w), 1 - 2 * (x*x + z*z), 2 * (y*z + x*w)];
  const back = [2 * (x*z + y*w), 2 * (y*z - x*w), 1 - 2 * (x*x + y*y)];
  const m = [[-right[0], -right[1], right[2]], [up[0], up[1], -up[2]], [back[0], back[1], -back[2]]];
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m[2][1])));
  const yaw = Math.hypot(m[2][0], m[2][2]) < 1e-8 ? 0 : Math.atan2(-m[2][0], m[2][2]);
  const baseX = [Math.cos(yaw), 0, Math.sin(yaw)];
  const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const roll = Math.atan2(dot(m[1], baseX), dot(m[0], baseX));
  return { yaw: (yaw * 180 / Math.PI + 360) % 360, pitch: pitch * 180 / Math.PI, roll: roll * 180 / Math.PI, orientationQuaternion: values };
}

export function nearestTarget(q: Quaternion, captured: ReadonlySet<number>) {
  const look = new Vector3(0, 0, -1).applyQuaternion(q);
  let nearest: Target | null = null;
  let distance = Infinity;
  for (const target of TARGETS) {
    if (captured.has(target.id)) continue;
    const phi = (90 - target.pitch) * Math.PI / 180;
    const theta = target.yaw * Math.PI / 180;
    const direction = new Vector3(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta));
    const angle = look.angleTo(direction);
    if (angle < distance) { nearest = target; distance = angle; }
  }
  return { target: nearest, distance };
}
