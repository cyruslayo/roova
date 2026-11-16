import type { Pose, Target } from './core';
import type { CameraStreamInfo } from './camera-stream';

export type SavedFrame = {
  key: string; roomId: string; targetId: number; targetYaw: number; targetPitch: number;
  imageBlob: Blob; width: number; height: number; timestamp: string; videoTime: number;
  pose: Pose;
  /** What the camera stream actually delivered when this frame was taken (absent on older frames). */
  camera?: CameraStreamInfo;
};

// How a frame is kept in IndexedDB. New records keep the JPEG as plain bytes
// (`imageBytes`): Safari keeps IndexedDB Blobs as separate files, and a stored
// Blob that can no longer be read was reported on an iPhone (2026-11-16).
// Records written before that keep `imageBlob` and are still read.
type StoredFrame = Omit<SavedFrame, 'imageBlob'> & { imageBlob?: Blob; imageBytes?: ArrayBuffer; imageType?: string };
const toSavedFrame = (record: StoredFrame): SavedFrame => {
  const { imageBytes, imageType, imageBlob, ...rest } = record;
  return { ...rest, imageBlob: imageBytes ? new Blob([imageBytes], { type: imageType || 'image/jpeg' }) : (imageBlob as Blob) };
};
const toStoredFrame = (frame: SavedFrame, bytes: ArrayBuffer): StoredFrame => {
  const { imageBlob, ...rest } = frame;
  return { ...rest, imageBytes: bytes, imageType: imageBlob.type || 'image/jpeg' };
};

export type SavedPanorama = { roomId: string; imageBlob: Blob; width: number; height: number; timestamp: string; sourceIds: number[] };
type StoredPanorama = Omit<SavedPanorama, 'imageBlob'> & { imageBlob: Blob | null; fileName?: string };
export type StitchJob = { roomId: string; state: 'running' | 'failed' | 'complete'; message: string; updatedAt: string };
const DB_NAME = 'stillroom-capture';
const STORE = 'frames';
const PANORAMAS = 'panoramas', JOBS = 'stitch-jobs';

function open(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('This browser does not provide local image storage.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('roomId', 'roomId');
      }
      if (!db.objectStoreNames.contains(PANORAMAS)) db.createObjectStore(PANORAMAS, { keyPath: 'roomId' });
      if (!db.objectStoreNames.contains(JOBS)) db.createObjectStore(JOBS, { keyPath: 'roomId' });
    };
    request.onerror = () => reject(request.error ?? new Error('Local storage could not be opened.'));
    request.onblocked = () => reject(new Error('Close other Stillroom tabs, then retry local storage.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function record<T>(store: string, mode: IDBTransactionMode, operation: (object: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db=await open();
  try { return await new Promise<T>((resolve,reject)=>{
    const tx=db.transaction(store,mode);let value:T;
    const request=operation(tx.objectStore(store));
    request.onsuccess=()=>{value=request.result;};
    tx.oncomplete=()=>resolve(value);
    tx.onerror=()=>reject(tx.error??new Error('Device storage failed.'));
    tx.onabort=()=>reject(tx.error??new Error('Device storage was interrupted.'));
  }); } finally { db.close(); }
}

export function loadStitchJob(roomId: string): Promise<StitchJob | undefined> { return record(JOBS,'readonly',store=>store.get(roomId)); }
export function saveStitchJob(job: StitchJob): Promise<StitchJob> { return record(JOBS,'readwrite',store=>store.put(job)).then(()=>job); }

async function opfsFile(fileName: string, create: boolean) {
  if (!navigator.storage?.getDirectory) return null;
  const root=await navigator.storage.getDirectory();
  const dir=await root.getDirectoryHandle('stillroom-panoramas', {create});
  return dir.getFileHandle(fileName,{create});
}

async function writeInWorker(fileName: string, imageBlob: Blob): Promise<boolean> {
  if (typeof Worker === 'undefined') return false;
  let worker: Worker;
  try { worker = new Worker(new URL('./opfs-panorama-worker.ts', import.meta.url), { type: 'module' }); }
  catch { return false; }
  try {
    return await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 60000);
      worker.onmessage = event => { clearTimeout(timer); resolve(event.data.ok === true); };
      worker.onerror = () => { clearTimeout(timer); resolve(false); };
      worker.onmessageerror = () => { clearTimeout(timer); resolve(false); };
      worker.postMessage({ fileName, imageBlob });
    });
  } finally { worker.terminate(); }
}

export async function savePanorama(panorama: SavedPanorama): Promise<void> {
  if(panorama.imageBlob.type!=='image/jpeg' || !panorama.imageBlob.size || panorama.width!==4096 || panorama.height!==2048)throw new Error('Invalid panorama output.');
  // Each attempt uses a fresh file so a failed restitch never damages an older panorama.
  const fileName = `${panorama.roomId.replace(/[^a-zA-Z0-9_-]/g,'_')}-${crypto.randomUUID()}.jpg`;
  let written = false;
  if (typeof navigator.storage?.getDirectory === 'function') {
    try {
      const handle = await opfsFile(fileName, true);
      if (handle && typeof handle.createWritable === 'function') {
        const writer = await handle.createWritable();
        try { await writer.write(panorama.imageBlob); await writer.close(); written = true; }
        catch (error) { await writer.abort().catch(() => {}); throw error; }
      } else if (handle) {
        written = await writeInWorker(fileName, panorama.imageBlob);
      }
    } catch { /* OPFS is optional; IndexedDB is the persistent fallback. */ }
  }
  await record(PANORAMAS,'readwrite',store=>store.put({ ...panorama, fileName: written ? fileName : undefined, imageBlob: written ? null : panorama.imageBlob } satisfies StoredPanorama));
}

export async function loadPanorama(roomId: string): Promise<SavedPanorama | null> {
  const meta=await record<StoredPanorama | undefined>(PANORAMAS,'readonly',store=>store.get(roomId));
  if(!meta)return null;
  if(meta.imageBlob)return { ...meta, imageBlob: meta.imageBlob };
  // Older panoramas used the room ID itself as the OPFS filename.
  const fileName = meta.fileName ?? `${roomId.replace(/[^a-zA-Z0-9_-]/g,'_')}.jpg`;
  try { const file=await (await opfsFile(fileName,false))?.getFile();return file?{...meta,imageBlob:file}:null; }
  catch { return null; }
}

export async function loadFrames(roomId: string): Promise<SavedFrame[]> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).index('roomId').getAll(roomId);
      let frames: SavedFrame[] = [];
      request.onsuccess = () => { frames = (request.result as StoredFrame[]).map(toSavedFrame); };
      tx.oncomplete = () => resolve(frames.sort((a, b) => a.targetId - b.targetId));
      tx.onerror = () => reject(tx.error ?? new Error('Could not read saved room frames.'));
      tx.onabort = () => reject(tx.error ?? new Error('Could not read saved room frames.'));
    });
  } finally { db.close(); }
}

export async function saveFrame(roomId: string, target: Target, imageBlob: Blob, width: number, height: number, timestamp: string, videoTime: number, pose: Pose, camera?: CameraStreamInfo): Promise<SavedFrame> {
  if (imageBlob.type !== 'image/jpeg' || !imageBlob.size || width <= 0 || height <= 0) throw new Error('The camera did not produce a valid JPEG.');
  const frame: SavedFrame = { key: `${roomId}:${target.id}`, roomId, targetId: target.id, targetYaw: target.yaw, targetPitch: target.pitch, imageBlob, width, height, timestamp, videoTime, pose, ...(camera ? { camera } : {}) };
  // Read the bytes before the transaction opens: an await inside it would end it.
  const bytes = await imageBlob.arrayBuffer();
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(toStoredFrame(frame, bytes));
      // A request can succeed and its transaction still abort: only complete marks capture saved.
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not save the frame.'));
      tx.onabort = () => reject(tx.error ?? new Error('Could not save the frame.'));
    });
    return frame;
  } finally { db.close(); }
}

/** One frame, read again on its own connection (used to retry a failed read). */
export async function loadFrame(roomId: string, targetId: number): Promise<SavedFrame | null> {
  const record = await new Promise<StoredFrame | undefined>((resolve, reject) => {
    open().then(db => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(`${roomId}:${targetId}`);
      let value: StoredFrame | undefined;
      request.onsuccess = () => { value = request.result as StoredFrame | undefined; };
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Could not read the saved frame.')); };
    }, reject);
  });
  return record ? toSavedFrame(record) : null;
}

export type FrameReadProblem = { targetId: number; reason: string };
const reasonOf = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** Reads every saved frame's image in full and lists the ones this browser cannot read. */
export async function checkFrames(roomId: string): Promise<{ frames: number; unreadable: FrameReadProblem[] }> {
  const frames = await loadFrames(roomId), unreadable: FrameReadProblem[] = [];
  for (const frame of frames) {
    try {
      const bytes = new Uint8Array(await frame.imageBlob.arrayBuffer());
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) unreadable.push({ targetId: frame.targetId, reason: 'not a JPEG' });
    } catch (error) { unreadable.push({ targetId: frame.targetId, reason: reasonOf(error) }); }
  }
  return { frames: frames.length, unreadable };
}

/** Replaces the given frames of one room in a single transaction (all or none). */
export async function replaceFrames(roomId: string, frames: SavedFrame[]): Promise<void> {
  if (frames.some(frame => frame.roomId !== roomId)) throw new Error('These frames belong to a different room.');
  const stored = await Promise.all(frames.map(async frame => toStoredFrame(frame, await frame.imageBlob.arrayBuffer())));
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE);
      for (const record of stored) store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not restore the frames.'));
      tx.onabort = () => reject(tx.error ?? new Error('Could not restore the frames.'));
    });
  } finally { db.close(); }
}
