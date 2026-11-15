import { describe, expect, it } from 'vitest';
import { TARGETS } from './core';
import { alignmentFallbackDetail, baselineFov, requireCompleteRoom, stitchPose, workingFrameSize } from './stitch';
import type { SavedFrame } from './storage';

const frame = (targetId: number): SavedFrame => ({
  key: `room:${targetId}`, roomId: 'room', targetId, targetYaw: TARGETS[targetId-1].yaw,
  targetPitch: TARGETS[targetId-1].pitch, imageBlob: new Blob(['jpeg'], {type:'image/jpeg'}),
  width: 720, height: 1280, timestamp: new Date().toISOString(), videoTime: 0,
  pose: {yaw: TARGETS[targetId-1].yaw,pitch: TARGETS[targetId-1].pitch,roll:0,orientationQuaternion:[0,0,0,1]}
});

describe('complete room gate',()=>{
  it('rejects a missing target even if there are 37 frames including a duplicate',()=>{
    const frames=TARGETS.slice(0,36).map(t=>frame(t.id));frames.push(frame(1));
    expect(()=>requireCompleteRoom(frames)).toThrow(/37.*Missing targets: 37/);
  });
  it('requires a valid image and measured pose for each target',()=>{
    const frames=TARGETS.map(t=>frame(t.id));
    expect(()=>requireCompleteRoom(frames)).not.toThrow();
    frames[36].pose.pitch=NaN;
    expect(()=>requireCompleteRoom(frames)).toThrow(/Target 37/);
  });
});

describe('frame geometry preparation', () => {
  it('keeps the source aspect when resizing frames for the GPU', () => {
    expect(workingFrameSize(1080, 1920, 1280)).toEqual({ width: 720, height: 1280 });
    expect(workingFrameSize(1080, 1920, 1920)).toEqual({ width: 1080, height: 1920 });
    expect(workingFrameSize(1080, 1440, 1280)).toEqual({ width: 960, height: 1280 });
    const { width, height } = workingFrameSize(1079, 1917, 1280);
    expect(height / width).toBeCloseTo(1917 / 1079, 2);
  });
  it('derives the vertical field of view from the real frame shape, matching VFTCam at 9:16', () => {
    const portrait = baselineFov(720, 1280);
    expect(portrait.horizontal).toBeCloseTo(43.2, 6);
    expect(portrait.vertical).toBeCloseTo(70.28, 2);
    const fourThree = baselineFov(960, 1280);
    expect(fourThree.vertical).toBeCloseTo(70.28, 2);
    expect(Math.tan(fourThree.horizontal * Math.PI / 360) / Math.tan(fourThree.vertical * Math.PI / 360)).toBeCloseTo(960 / 1280, 6);
  });
  it('re-derives the stitch pose from the stored capture quaternion', () => {
    const f = frame(13);
    f.pose = { ...f.pose, yaw: 999, orientationQuaternion: [0, 1, 0, 0] };
    const pose = stitchPose(f);
    expect(pose.hasFullOrientation).toBe(true);
    expect(pose.yaw).toBeCloseTo(0, 6);
    expect(pose.pitch).toBeCloseTo(0, 6);
  });
  it('explains why image alignment fell back instead of hiding it', () => {
    const thrown = alignmentFallbackDetail('align failed: RangeError: Array buffer allocation failed', { stage: 'matching', frames: 37, corners: [0, 3, 40] });
    expect(thrown).toContain('error: RangeError: Array buffer allocation failed');
    expect(thrown).toContain('last stage matching');
    expect(thrown).toContain('min 0 / median 3 / max 40, 2 frames under 10');
    const sparse = alignmentFallbackDetail(undefined, { stage: 'solve', frames: 37, reason: 'no focal scale', corners: [5, 6, 7], pairsTried: 200, matchesFound: 40, pairsMatched: 2, matchesKept: 12, focal: [{ focal: 1, measured: 2, consistent: 1, far: 1 }] });
    expect(sparse).toContain('no focal scale');
    expect(sparse).toContain('2/200 ordered pairs matched (12 of 40 matches kept)');
    expect(sparse).toContain('x1.00 1/1');
    expect(alignmentFallbackDetail(undefined, null)).toContain('no diagnostics returned');
  });
});
