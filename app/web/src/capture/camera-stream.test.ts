import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANDIDATES, candidatesFor, openRearCamera, shapeName } from './camera-stream';

type Fake = { width: number; height: number } | 'denied' | 'fail';
const fakeCamera = (answers: Fake[]) => {
  const stopped: string[] = [], asked: MediaTrackConstraints[] = [];
  let call = 0;
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async ({ video }: { video: MediaTrackConstraints }) => {
    asked.push(video);
    const answer = answers[call++];
    if (answer === 'denied') throw new DOMException('denied', 'NotAllowedError');
    if (answer === 'fail' || !answer) throw new DOMException('no format', 'OverconstrainedError');
    const id = `stream${call}`;
    const track = { label: 'Back Camera', getSettings: () => ({ width: answer.width, height: answer.height, frameRate: 30 }), getCapabilities: () => ({ width: { min: 192, max: 4032 } }), stop: () => stopped.push(id) };
    return { id, getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  } } });
  return { stopped, asked };
};
afterEach(() => vi.unstubAllGlobals());

describe('rear camera request', () => {
  it('names frame shapes regardless of orientation', () => {
    expect(shapeName(1440, 1920)).toBe('4:3');
    expect(shapeName(1920, 1080)).toBe('16:9');
    expect(shapeName(null, 1080)).toBe('unknown');
  });
  it('asks for 4:3 first in a new room, and for the room\'s own shape in an existing one', () => {
    expect(candidatesFor(null).map(c => c.name)).toEqual(CANDIDATES.map(c => c.name));
    expect(candidatesFor(null)[0].name).toMatch(/^4:3/);
    expect(candidatesFor({ width: 1080, height: 1920 }).map(c => c.name)).toEqual(['16:9 1920x1080']);
    expect(candidatesFor({ width: 1440, height: 1920 }).every(c => c.name.startsWith('4:3'))).toBe(true);
  });
  it('keeps the first stream that delivers the shape it asked for and records what it delivered', async () => {
    const { stopped } = fakeCamera([{ width: 1920, height: 1080 }, { width: 1440, height: 1920 }]);
    const { info, tried } = await openRearCamera(null);
    expect(info).toMatchObject({ request: '4:3 1440x1920', width: 1440, height: 1920, shape: '4:3', frameRate: 30, label: 'Back Camera', capabilities: { width: [192, 4032] } });
    expect(tried).toEqual(['4:3 1920x1440: 1920 x 1080 (16:9)', '4:3 1440x1920: 1440 x 1920 (4:3)']);
    expect(stopped).toEqual(['stream1']);  // the 16:9 attempt was closed
  });
  it('falls back to the last stream that opened when no 4:3 format is offered', async () => {
    fakeCamera([{ width: 1920, height: 1080 }, 'fail', { width: 1920, height: 1080 }, { width: 1080, height: 1920 }]);
    const { info } = await openRearCamera(null);
    expect(info).toMatchObject({ request: '16:9 1920x1080', shape: '16:9' });
  });
  it('stops at a denied permission instead of asking again', async () => {
    const { asked } = fakeCamera(['denied']);
    await expect(openRearCamera(null)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(asked).toHaveLength(1);
  });
});
