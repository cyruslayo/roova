import type { SavedFrame } from './storage';
import type { StitchResult } from './stitch';

// "Export source frames": an explicit, user-initiated save of a room's original
// JPEGs and their measured poses as one ZIP file, so a capture can be replayed
// through stitchRoom() on a desktop. Nothing is uploaded; the file is built on the
// device and handed to the browser's download. The ZIP is written here with the
// "stored" (uncompressed) method, because JPEGs do not compress further and this
// needs no third-party library.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; data: Uint8Array };

// Store-only ZIP (PKWARE APPNOTE 4.3): local headers, data, central directory, end record.
export function buildZip(entries: ZipEntry[], date = new Date()): Blob {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const encoder = new TextEncoder(), parts: BlobPart[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name), crc = crc32(entry.data), size = entry.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, size, true); local.setUint32(22, size, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(local.buffer, name, entry.data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true); dir.setUint16(12, dosTime, true); dir.setUint16(14, dosDate, true);
    dir.setUint32(16, crc, true); dir.setUint32(20, size, true); dir.setUint32(24, size, true);
    dir.setUint16(28, name.length, true); dir.setUint32(42, offset, true);
    const record = new Uint8Array(46 + name.length); record.set(new Uint8Array(dir.buffer)); record.set(name, 46);
    central.push(record);
    offset += 30 + name.length + size;
  }
  const centralSize = central.reduce((sum, record) => sum + record.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

export const frameFileName = (targetId: number) => `frames/target-${String(targetId).padStart(2, '0')}.jpg`;

export type FrameExportManifest = {
  format: 'roova-source-frames'; version: 1; roomId: string; exportedAt: string;
  device: { userAgent: string; platform: string; screen: string; devicePixelRatio: number };
  frames: {
    file: string; targetId: number; targetYaw: number; targetPitch: number;
    yaw: number; pitch: number; roll: number; orientationQuaternion: [number, number, number, number];
    width: number; height: number; bytes: number; timestamp: string; videoTime: number;
  }[];
  lastStitch: Omit<StitchResult, 'blob'> | null;
};

// Reads each stored frame into memory first (Safari can fail on IndexedDB-backed blobs otherwise).
export async function buildFrameExport(roomId: string, frames: SavedFrame[], lastStitch: StitchResult | null): Promise<{ blob: Blob; manifest: FrameExportManifest }> {
  const sorted = [...frames].sort((a, b) => a.targetId - b.targetId), entries: ZipEntry[] = [];
  const manifest: FrameExportManifest = {
    format: 'roova-source-frames', version: 1, roomId, exportedAt: new Date().toISOString(),
    device: { userAgent: navigator.userAgent, platform: navigator.platform ?? '', screen: `${screen.width} × ${screen.height}`, devicePixelRatio: devicePixelRatio },
    frames: [], lastStitch: null,
  };
  if (lastStitch) { const { blob: _omit, ...rest } = lastStitch; manifest.lastStitch = rest; }
  for (const frame of sorted) {
    let data: Uint8Array;
    try { data = new Uint8Array(await frame.imageBlob.arrayBuffer()); }
    catch { throw new Error(`The saved image for target ${frame.targetId} cannot be read from this browser's storage, so it cannot be exported. The other saved frames are kept.`); }
    const file = frameFileName(frame.targetId);
    entries.push({ name: file, data });
    manifest.frames.push({
      file, targetId: frame.targetId, targetYaw: frame.targetYaw, targetPitch: frame.targetPitch,
      yaw: frame.pose.yaw, pitch: frame.pose.pitch, roll: frame.pose.roll, orientationQuaternion: frame.pose.orientationQuaternion,
      width: frame.width, height: frame.height, bytes: data.length, timestamp: frame.timestamp, videoTime: frame.videoTime,
    });
  }
  entries.unshift({ name: 'poses.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  return { blob: buildZip(entries), manifest };
}

// Reads a store-only ZIP written by buildZip (used by tests and the desktop replay).
export function readZip(buffer: ArrayBuffer): Map<string, Uint8Array> {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer), files = new Map<string, Uint8Array>(), decoder = new TextDecoder();
  let end = buffer.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Not a ZIP file.');
  let p = view.getUint32(end + 16, true);
  for (let k = view.getUint16(end + 10, true); k > 0; k--) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged ZIP directory.');
    if (view.getUint16(p + 10, true) !== 0) throw new Error('Only uncompressed ZIP entries are supported.');
    const size = view.getUint32(p + 20, true), nameLength = view.getUint16(p + 28, true), extra = view.getUint16(p + 30, true), comment = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true), name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.slice(start, start + size);
    if (crc32(data) !== view.getUint32(p + 16, true)) throw new Error(`Checksum mismatch in ${name}.`);
    files.set(name, data);
    p += 46 + nameLength + extra + comment;
  }
  return files;
}

/**
 * Turns a ZIP made by "Export source frames" back into saved frames for one room,
 * for restoring frames this browser can no longer read. Checks the format, the
 * room, every listed file and that each one is a JPEG of the recorded size.
 */
export function framesFromExport(buffer: ArrayBuffer, roomId: string): SavedFrame[] {
  const files = readZip(buffer), raw = files.get('poses.json');
  if (!raw) throw new Error('This file is not a Stillroom frame export (poses.json is missing).');
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as FrameExportManifest;
  if (manifest.format !== 'roova-source-frames' || manifest.version !== 1) throw new Error('This file is not a Stillroom frame export.');
  if (manifest.roomId !== roomId) throw new Error('This export belongs to a different room, so it was not used.');
  return manifest.frames.map(f => {
    const data = files.get(f.file);
    if (!data || data.length !== f.bytes || data[0] !== 0xff || data[1] !== 0xd8) throw new Error(`Target ${f.targetId} in this export is missing or damaged.`);
    return {
      key: `${roomId}:${f.targetId}`, roomId, targetId: f.targetId, targetYaw: f.targetYaw, targetPitch: f.targetPitch,
      imageBlob: new Blob([data], { type: 'image/jpeg' }), width: f.width, height: f.height, timestamp: f.timestamp, videoTime: f.videoTime,
      pose: { yaw: f.yaw, pitch: f.pitch, roll: f.roll, orientationQuaternion: f.orientationQuaternion },
    };
  });
}
