import { describe, expect, it } from 'vitest';
import { defaultCameraSettings, modeBaseFov, nadirFillDegrees, normalizeCameraSettings, planFov, type CameraSettings } from './camera-settings';
import { baselineFov } from './stitch';

const withOffsets = (mode: 'indoor' | 'outdoor', horizontal: number, vertical: number): CameraSettings => {
  const s = defaultCameraSettings(); s.mode = mode; s.offsets[mode] = { horizontal, vertical }; return s;
};

describe('camera settings', () => {
  it('uses VFTCam base values: indoor 43.2 x 70.28, outdoor 45.7 x 73.3 for 9:16 portrait frames', () => {
    const indoor = modeBaseFov(720, 1280, 'indoor'), outdoor = modeBaseFov(720, 1280, 'outdoor');
    expect(indoor.horizontal).toBeCloseTo(43.2, 6);
    expect(indoor.vertical).toBeCloseTo(70.28, 2);
    expect(outdoor).toEqual({ horizontal: 45.7, vertical: 73.3 });
    // The indoor base is the product's existing baseline for every frame shape.
    const shape = modeBaseFov(960, 1280, 'indoor'), baseline = baselineFov(960, 1280);
    expect(shape.horizontal).toBeCloseTo(baseline.horizontal, 9);
    expect(shape.vertical).toBeCloseTo(baseline.vertical, 9);
  });
  it('calibrates by default, as VFTCam does with no saved offsets', () => {
    expect(planFov(720, 1280, defaultCameraSettings()).source).toBe('calibrate');
  });
  it('replaces calibration with base plus offsets when either offset is non-zero', () => {
    const plan = planFov(720, 1280, withOffsets('indoor', -6, -9));
    expect(plan.source).toBe('manual');
    if (plan.source !== 'manual') return;
    expect(plan.fov.horizontal).toBeCloseTo(37.2, 6);
    expect(plan.fov.vertical).toBeCloseTo(61.28, 2);
    expect(planFov(720, 1280, withOffsets('indoor', 0, 0.5)).source).toBe('manual');
  });
  it('keeps separate offsets per mode', () => {
    const s = withOffsets('outdoor', 2, 1);
    expect(planFov(720, 1280, s)).toMatchObject({ source: 'manual', fov: { horizontal: 47.7, vertical: 74.3 } });
    s.mode = 'indoor';
    expect(planFov(720, 1280, s).source).toBe('calibrate');
  });
  it('puts the developer override first and derives its vertical from the frame aspect', () => {
    const plan = planFov(720, 1280, withOffsets('indoor', -6, -9), { horizontal: 40, vertical: null });
    expect(plan.source).toBe('override');
    if (plan.source !== 'override') return;
    expect(plan.fov.horizontal).toBe(40);
    expect(Math.tan(plan.fov.vertical * Math.PI / 360) / Math.tan(20 * Math.PI / 180)).toBeCloseTo(1280 / 720, 6);
    expect(planFov(720, 1280, defaultCameraSettings(), { horizontal: Number.NaN }).source).toBe('calibrate');
  });
  it('clamps stored values to +-10 degrees in 0.5 degree steps and ignores junk', () => {
    const s = normalizeCameraSettings({ mode: 'outdoor', tripod: 'yes', offsets: { outdoor: { horizontal: -14, vertical: 2.26 }, indoor: { horizontal: 'x' } } });
    expect(s).toEqual({ mode: 'outdoor', tripod: false, offsets: { outdoor: { horizontal: -10, vertical: 2.5 }, indoor: { horizontal: 0, vertical: 0 } } });
    expect(normalizeCameraSettings(null)).toEqual(defaultCameraSettings());
  });
  it('widens the nadir fill to 22 degrees only with the tripod setting', () => {
    expect(nadirFillDegrees(defaultCameraSettings())).toBe(0);
    expect(nadirFillDegrees({ ...defaultCameraSettings(), tripod: true })).toBe(22);
  });
});
