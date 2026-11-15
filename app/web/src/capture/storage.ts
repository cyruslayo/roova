import type { Pose, Target } from './core';

export type SavedFrame = {
  key: string; roomId: string; targetId: number; targetYaw: number; targetPitch: number;
  imageBlob: Blob; width: number; height: number; timestamp: string; videoTime: number;
  pose: Pose;
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
