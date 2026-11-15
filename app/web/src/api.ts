import { clearUploadCheckpoint, readUploadCheckpoint, saveUploadCheckpoint, uploadCheckpointKey, type SavedPart } from './multipart';

export type Tour = { id: string; title: string; roomName: string; slug?: string; state: string; publishedAt?: string | null; failureReason?: string | null; createdAt?: string; updatedAt?: string };
export type Scene = { posterUrl?: string; panoramaUrl?: string; smallSpzUrl?: string; largeSpzUrl?: string; sourceVideoUrl?: string | null; spatial?: { metricScaleFactor?: number | null; groundPlaneOffset?: number | null; [key: string]: unknown } | null };
export type PublicTour = { tour: { title: string; roomName: string; slug: string }; scene: Scene };
const apiBase = import.meta.env.VITE_API_BASE ?? '';
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (typeof init?.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${apiBase}${path}`, { ...init, headers });
  if (!response.ok) throw new Error((await response.text()).slice(0, 240) || `Request failed (${response.status})`);
  return response.json() as Promise<T>;
}
export const api = {
  list: () => request<{ tours: Tour[] }>('/api/tours'),
  create: (title: string, roomName: string) => request<{ tour: Tour }>('/api/tours', { method: 'POST', body: JSON.stringify({ title, roomName }) }),
  get: (id: string) => request<{ tour: Tour; scene?: Scene; sourceUrl?: string | null }>(`/api/tours/${encodeURIComponent(id)}`),
  status: (id: string) => request<{ tour: Tour; job?: { state?: string; attempts?: number; provider_error?: string | null; provider_operation_id?: string | null } | null }>(`/api/tours/${encodeURIComponent(id)}/status`),
  approve: (id: string) => request<{ tour: Tour }>(`/api/tours/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  publish: (id: string) => request<{ tour: Tour }>('/api/tours/' + encodeURIComponent(id) + '/publish', { method: 'POST' }),
  publicTour: (slug: string) => request<PublicTour>(`/api/public/tours/${encodeURIComponent(slug)}`),
  async upload(id: string, file: File, progress: (value: string) => void) {
    const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
    const tail = file.size > 64 * 1024 ? new Uint8Array(await file.slice(Math.max(0, file.size - 64 * 1024)).arrayBuffer()) : new Uint8Array();
    const sample = new Uint8Array(head.length + tail.length); sample.set(head); sample.set(tail, head.length);
    const digest = globalThis.crypto?.subtle ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', sample)) : sample;
    const fingerprint = `${file.name}:${file.size}:${file.lastModified}:${file.type}:${[...digest].map(n => n.toString(16).padStart(2, '0')).join('')}`;
    const checkpointKey = uploadCheckpointKey(id, fingerprint);
    let storage: Storage | null = null; try { storage = window.localStorage; } catch { /* Storage can be disabled. */ }
    let checkpoint = storage ? readUploadCheckpoint(storage, checkpointKey) : null;
    if (checkpoint) {
      const response = await fetch(`${apiBase}/api/uploads/${encodeURIComponent(checkpoint.uploadId)}`);
      if (response.status === 404) { checkpoint = null; if (storage) clearUploadCheckpoint(storage, checkpointKey); }
      else if (!response.ok) throw new Error(`Could not verify resumable upload (${response.status})`);
      else {
        const server = await response.json() as { status: string; bytes: number; partSize: number; parts: SavedPart[] };
        if (server.bytes !== file.size || server.partSize !== checkpoint.partSize) { checkpoint = null; if (storage) clearUploadCheckpoint(storage, checkpointKey); }
        else if (server.status === 'complete') { if (storage) clearUploadCheckpoint(storage, checkpointKey); return request<{ tour: Tour }>(`/api/uploads/${encodeURIComponent(checkpoint.uploadId)}/complete`, { method: 'POST', body: JSON.stringify({ parts: [] }) }); }
        else checkpoint = { ...checkpoint, parts: server.parts };
      }
    }
    const { uploadId, partSize } = checkpoint ?? await request<{ uploadId: string; partSize: number }>(`/api/tours/${encodeURIComponent(id)}/uploads`, { method: 'POST', body: JSON.stringify({ fileName: file.name, bytes: file.size, mime: file.type || 'application/octet-stream' }) });
    if (!Number.isSafeInteger(partSize) || partSize <= 0) throw new Error('Upload service returned an invalid part size.');
    const parts: SavedPart[] = checkpoint?.parts.slice() ?? [];
    if (storage) saveUploadCheckpoint(storage, checkpointKey, { uploadId, partSize, parts });
    const total = Math.ceil(file.size / partSize);
    for (let i = 0; i < total; i++) {
      if (parts.some(part => part.partNumber === i + 1)) { progress(`Resuming upload · part ${i + 1} of ${total} already received`); continue; }
      const blob = file.slice(i * partSize, Math.min(file.size, (i + 1) * partSize));
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          progress(attempt === 1 ? `Uploading part ${i + 1} of ${total}` : `Retrying part ${i + 1} · attempt ${attempt} of 3`);
          const result = await request<{ etag: string }>(`/api/uploads/${encodeURIComponent(uploadId)}/parts/${i + 1}`, { method: 'PUT', body: blob, headers: { 'Content-Type': 'application/octet-stream' } });
          parts.push({ partNumber: i + 1, etag: result.etag });
          if (storage) saveUploadCheckpoint(storage, checkpointKey, { uploadId, partSize, parts });
          lastError = null;
          break;
        } catch (error) { lastError = error; }
      }
      if (lastError) throw lastError;
    }
    progress('Finishing upload');
    const result = await request<{ tour: Tour }>(`/api/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST', body: JSON.stringify({ parts }) });
    if (storage) clearUploadCheckpoint(storage, checkpointKey);
    return result;
  }
};
