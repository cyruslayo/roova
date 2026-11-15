import { describe, expect, it } from 'vitest';
import { TARGETS } from './core';
import { requireCompleteRoom } from './stitch';
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
