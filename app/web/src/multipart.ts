export type SavedPart = { partNumber: number; etag: string };
export type UploadCheckpoint = { uploadId: string; partSize: number; parts: SavedPart[] };
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function uploadCheckpointKey(tourId: string, fingerprint: string) {
  return `stillroom:upload:${tourId}:${fingerprint}`;
}

export function readUploadCheckpoint(storage: StorageLike, key: string): UploadCheckpoint | null {
  try {
    const value = storage.getItem(key);
    if (!value) return null;
    const parsed = JSON.parse(value) as UploadCheckpoint;
    if (!parsed.uploadId || !Number.isSafeInteger(parsed.partSize) || parsed.partSize <= 0 || !Array.isArray(parsed.parts)) return null;
    if (parsed.parts.some(part => !Number.isInteger(part.partNumber) || part.partNumber < 1 || typeof part.etag !== 'string')) return null;
    return parsed;
  } catch { return null; }
}

export function saveUploadCheckpoint(storage: StorageLike, key: string, checkpoint: UploadCheckpoint) {
  try { storage.setItem(key, JSON.stringify(checkpoint)); } catch { /* Storage can be disabled or full; transfer remains usable. */ }
}

export function clearUploadCheckpoint(storage: StorageLike, key: string) {
  try { storage.removeItem(key); } catch { /* Storage can be disabled. */ }
}
