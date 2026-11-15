import type { Pose, Target } from './core';

export type SavedFrame = {
  key: string; roomId: string; targetId: number; targetYaw: number; targetPitch: number;
  imageBlob: Blob; width: number; height: number; timestamp: string; videoTime: number;
  pose: Pose;
};

const DB_NAME = 'stillroom-capture';
const STORE = 'frames';

function open(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('This browser does not provide local image storage.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('roomId', 'roomId');
      }
    };
    request.onerror = () => reject(request.error ?? new Error('Local storage could not be opened.'));
    request.onblocked = () => reject(new Error('Close other Stillroom tabs, then retry local storage.'));
    request.onsuccess = () => resolve(request.result);
  });
}

export async function loadFrames(roomId: string): Promise<SavedFrame[]> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).index('roomId').getAll(roomId);
      let frames: SavedFrame[] = [];
      request.onsuccess = () => { frames = request.result as SavedFrame[]; };
      tx.oncomplete = () => resolve(frames.sort((a, b) => a.targetId - b.targetId));
      tx.onerror = () => reject(tx.error ?? new Error('Could not read saved room frames.'));
      tx.onabort = () => reject(tx.error ?? new Error('Could not read saved room frames.'));
    });
  } finally { db.close(); }
}

export async function saveFrame(roomId: string, target: Target, imageBlob: Blob, width: number, height: number, timestamp: string, videoTime: number, pose: Pose): Promise<SavedFrame> {
  if (imageBlob.type !== 'image/jpeg' || !imageBlob.size || width <= 0 || height <= 0) throw new Error('The camera did not produce a valid JPEG.');
  const frame: SavedFrame = { key: `${roomId}:${target.id}`, roomId, targetId: target.id, targetYaw: target.yaw, targetPitch: target.pitch, imageBlob, width, height, timestamp, videoTime, pose };
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(frame);
      // A request can succeed and its transaction still abort: only complete marks capture saved.
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not save the frame.'));
      tx.onabort = () => reject(tx.error ?? new Error('Could not save the frame.'));
    });
    return frame;
  } finally { db.close(); }
}
