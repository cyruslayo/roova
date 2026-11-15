import { describe, expect, it } from 'vitest';
import { constrainLook } from './camera';
import { spatialTransform } from './spatialTransform';

describe('constrained stationary look camera', () => {
  it('clamps yaw, pitch, and zoom to a safe look-around range', () => {
    expect(constrainLook(-4, -2, 0)).toEqual({ yaw: -1.35, pitch: -0.55, zoom: 0.72 });
    expect(constrainLook(4, 2, 8)).toEqual({ yaw: 1.35, pitch: 0.65, zoom: 1.48 });
  });
  it('preserves camera values inside the allowed range', () => {
    expect(constrainLook(0.2, 0.1, 1.1)).toEqual({ yaw: 0.2, pitch: 0.1, zoom: 1.1 });
  });
  it('applies SPZ metric scale before OpenCV rotation and world-up ground offset', () => {
    const transform = spatialTransform({ metricScaleFactor: 2, groundPlaneOffset: 0.35 });
    const raw = { x: 1, y: 2, z: 3 };
    const scaled = { x: raw.x * transform.metricScaleFactor, y: raw.y * transform.metricScaleFactor, z: raw.z * transform.metricScaleFactor };
    const rotated = { x: scaled.x, y: -scaled.y, z: -scaled.z };
    const result = { x: rotated.x, y: rotated.y + transform.groundPlaneOffset, z: rotated.z };
    expect(result).toEqual({ x: 2, y: -3.65, z: -6 });
  });
  it('uses neutral transform defaults when provider spatial metadata is absent', () => {
    expect(spatialTransform(null)).toEqual({ metricScaleFactor: 1, groundPlaneOffset: 0, rotationX: Math.PI });
  });
});
