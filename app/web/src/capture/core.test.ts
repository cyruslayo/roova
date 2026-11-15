import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { ALIGNMENT_THRESHOLD, APPROACH_THRESHOLD, CAPTURE_HOLD_MS, TARGETS, nearestTarget, orientationQuaternion, poseFromQuaternion } from './core';

describe('VFTCam capture model', () => {
  it('keeps all 37 targets with their original IDs, angles, and alignment timing', () => {
    expect(TARGETS).toHaveLength(37);
    expect(TARGETS.map(target => target.id)).toEqual(Array.from({ length: 37 }, (_, i) => i + 1));
    for (const [row, pitch] of [45, 0, -45].entries())
      expect(TARGETS.slice(row * 12, row * 12 + 12).map(({ yaw, pitch: p }) => [yaw, p]))
        .toEqual(Array.from({ length: 12 }, (_, i) => [i * 30, pitch]));
    expect(TARGETS[36]).toEqual({ id: 37, yaw: 0, pitch: 84 });
    expect([APPROACH_THRESHOLD, ALIGNMENT_THRESHOLD, CAPTURE_HOLD_MS]).toEqual([0.25, 0.08, 1000]);
  });

  it('measures a quaternion pose and excludes already saved targets from nearest selection', () => {
    const q = orientationQuaternion(0, 90, 0);
    const measured = poseFromQuaternion(q);
    expect(measured).not.toBeNull();
    expect(measured?.orientationQuaternion).toHaveLength(4);
    const forward = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
    const first = nearestTarget(forward, new Set<number>());
    expect(first.target).toEqual({ id: 13, yaw: 0, pitch: 0 });
    expect(first.distance).toBeLessThan(ALIGNMENT_THRESHOLD);
    expect(nearestTarget(forward, new Set([13])).target?.id).not.toBe(13);
  });
});
