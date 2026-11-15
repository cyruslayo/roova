// Safari exposes OPFS synchronous access handles in workers, even when
// FileSystemFileHandle.createWritable is unavailable on the main thread.
type SyncAccess = { write: (data: Uint8Array, options: {at: number}) => number; truncate: (size: number) => void; flush?: () => void; close: () => void };
type SafariFileHandle = FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<SyncAccess> };

self.onmessage = async (event: MessageEvent<{ fileName: string; imageBlob: Blob }>) => {
  const { fileName, imageBlob } = event.data;
  let access: SyncAccess | undefined;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('stillroom-panoramas', { create: true });
    const file = await dir.getFileHandle(fileName, { create: true }) as SafariFileHandle;
    if (typeof file.createSyncAccessHandle !== 'function') {
      self.postMessage({ ok: false, error: 'Synchronous OPFS writing is unavailable.' });
      return;
    }
    access = await file.createSyncAccessHandle();
    const bytes = new Uint8Array(await imageBlob.arrayBuffer());
    const written = access.write(bytes, { at: 0 });
    if (written !== bytes.byteLength) throw new Error('Panorama file was only partially written.');
    access.truncate(bytes.byteLength);
    access.flush?.();
    access.close();
    access = undefined;
    self.postMessage({ ok: true });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : 'OPFS write failed.' });
  } finally {
    access?.close();
  }
};
