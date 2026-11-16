import { describe, expect, it, vi } from 'vitest';
import { TARGETS } from './core';
import { buildFrameExport, buildZip, crc32, frameFileName, framesFromExport, readZip } from './export-frames';
import type { SavedFrame } from './storage';

const jpeg = (id: number) => new Uint8Array([0xff, 0xd8, id, 1, 2, 3, 0xff, 0xd9]);
const frame = (id: number): SavedFrame => {
  const target = TARGETS.find(t => t.id === id)!;
  return {
    key: `room:${id}`, roomId: 'room', targetId: id, targetYaw: target.yaw, targetPitch: target.pitch,
    imageBlob: new Blob([jpeg(id)], { type: 'image/jpeg' }), width: 1080, height: 1920, timestamp: `2026-11-15T10:00:${String(id).padStart(2, '0')}Z`, videoTime: id,
    pose: { yaw: target.yaw + 0.5, pitch: target.pitch - 0.25, roll: 1.5, orientationQuaternion: [0.1, 0.2, 0.3, 0.9] },
  };
};

describe('source frame export', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('writes a ZIP that reads back byte for byte', async () => {
    const zip = buildZip([{ name: 'a.txt', data: new TextEncoder().encode('hello') }, { name: 'frames/b.jpg', data: jpeg(7) }]);
    const files = readZip(await zip.arrayBuffer());
    expect(new TextDecoder().decode(files.get('a.txt'))).toBe('hello');
    expect([...files.get('frames/b.jpg')!]).toEqual([...jpeg(7)]);
  });
  it('exports all 37 original frames with their measured poses and dimensions', async () => {
    vi.stubGlobal('screen', { width: 414, height: 896 });
    vi.stubGlobal('devicePixelRatio', 3);
    const frames = TARGETS.map(t => frame(t.id)).reverse();
    const { blob, manifest } = await buildFrameExport('room', frames, null);
    const files = readZip(await blob.arrayBuffer());
    expect(files.size).toBe(38);
    const parsed = JSON.parse(new TextDecoder().decode(files.get('poses.json')));
    expect(parsed).toEqual(JSON.parse(JSON.stringify(manifest)));
    expect(parsed.frames.map((f: { targetId: number }) => f.targetId)).toEqual(TARGETS.map(t => t.id).sort((a, b) => a - b));
    const zenith = parsed.frames.find((f: { targetId: number }) => f.targetId === 37);
    expect(zenith).toMatchObject({ file: frameFileName(37), width: 1080, height: 1920, roll: 1.5, orientationQuaternion: [0.1, 0.2, 0.3, 0.9], videoTime: 37, bytes: 8 });
    expect([...files.get(frameFileName(37))!]).toEqual([...jpeg(37)]);
    vi.unstubAllGlobals();
  });
  it('restores frames from an export of the same room, byte for byte, and refuses anything else', async () => {
    vi.stubGlobal('screen', { width: 414, height: 896 });
    vi.stubGlobal('devicePixelRatio', 3);
    const { blob } = await buildFrameExport('room', TARGETS.map(t => frame(t.id)), null);
    const buffer = await blob.arrayBuffer();
    const restored = framesFromExport(buffer, 'room');
    expect(restored.map(f => f.targetId)).toEqual(TARGETS.map(t => t.id).sort((a, b) => a - b));
    const seven = restored.find(f => f.targetId === 7)!;
    expect([...new Uint8Array(await seven.imageBlob.arrayBuffer())]).toEqual([...jpeg(7)]);
    expect(seven).toMatchObject({ key: 'room:7', roomId: 'room', width: 1080, height: 1920, pose: { roll: 1.5, orientationQuaternion: [0.1, 0.2, 0.3, 0.9] } });
    expect(() => framesFromExport(buffer, 'other-room')).toThrow(/different room/);
    const files = readZip(buffer); files.set(frameFileName(3), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const damaged = await buildZip([...files].map(([name, data]) => ({ name, data }))).arrayBuffer();
    expect(() => framesFromExport(damaged, 'room')).toThrow(/Target 3/);
    const notExport = await buildZip([{ name: 'a.txt', data: new Uint8Array([1]) }]).arrayBuffer();
    expect(() => framesFromExport(notExport, 'room')).toThrow(/not a Stillroom frame export/);
    vi.unstubAllGlobals();
  });
});
