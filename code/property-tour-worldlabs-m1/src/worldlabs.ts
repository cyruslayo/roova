import {
  assertOperation, assertUpload, assertWorld,
  type GenerateVideoInput, type Operation, type PrepareUploadResponse, type UploadInfo, type World
} from "./contract.js";

const BASE = "https://api.worldlabs.ai/marble/v1";
export class WorldLabsHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterSeconds: number | null = null,
    public readonly requestId: string | null = null
  ) {
    super(`World Labs HTTP ${status}: ${message}`);
    this.name = "WorldLabsHttpError";
  }
}
export type Fetcher = typeof fetch;
export class WorldLabsClient {
  constructor(private readonly key: string, private readonly fetcher: Fetcher = fetch) {
    if (!key) throw new Error("Missing World Labs API key");
  }
  private async json(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${BASE}${path}`, {
        method,
        headers: {
          "WLT-Api-Key": this.key,
          "Accept": "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      // A failed generate POST is ambiguous and must NOT be automatically retried.
      throw new Error(`World Labs request failed; submission state may be uncertain: ${String(error)}`);
    }
    if (!response.ok) {
      const raw = await response.text();
      const requestId = response.headers.get("x-request-id");
      const retryHeader = response.headers.get("retry-after");
      const seconds = retryHeader === null ? null : parseRetryAfter(retryHeader);
      throw new WorldLabsHttpError(response.status, raw.slice(0, 500), seconds, requestId);
    }
    return response.json();
  }
  async prepareUpload(fileName: string, extension: string, metadata: Record<string, string> = {}): Promise<PrepareUploadResponse> {
    const data = await this.json("POST", "/media-assets:prepare_upload", {
      file_name: fileName.slice(-64), kind: "video", extension, metadata
    });
    assertUpload(data);
    return data;
  }
  async uploadBytes(upload: UploadInfo, bytes: ReadableStream<Uint8Array> | Blob, mime: string, byteLength?: number): Promise<void> {
    const url = new URL(upload.upload_url);
    if (url.protocol !== "https:") throw new Error("Signed upload URL must use HTTPS");
    const headers = new Headers(upload.required_headers ?? {});
    if (!headers.has("content-type")) headers.set("content-type", mime);
    // Storage signed PUT endpoints may reject chunked transfer encoding.
    // Set the known file length when streaming from a local file.
    if (byteLength !== undefined && !headers.has("content-length")) {
      if (!Number.isSafeInteger(byteLength) || byteLength <= 0) throw new Error("Invalid source byte length");
      headers.set("content-length", String(byteLength));
    }
    // Signed upload MUST NOT contain the API key.
    const init: RequestInit & { duplex?: "half" } = {
      method: upload.upload_method, headers,
      body: bytes,
      redirect: "error", signal: AbortSignal.timeout(900_000)
    };
    if (!(bytes instanceof Blob)) init.duplex = "half";
    const response = await this.fetcher(url.toString(), init);
    if (!response.ok) {
      throw new Error(`Signed video upload failed with HTTP ${response.status}`);
    }
  }
  async generateVideo(input: GenerateVideoInput): Promise<Operation> {
    const result = await this.json("POST", "/worlds:generate", {
      display_name: input.displayName.slice(0, 64),
      model: input.model ?? "marble-1.1",
      permission: { public: false },
      world_prompt: {
        type: "video",
        video_prompt: { source: "media_asset", media_asset_id: input.mediaAssetId }
      }
    });
    assertOperation(result);
    return result;
  }
  async operation(id: string): Promise<Operation> {
    const result = await this.json("GET", `/operations/${encodeURIComponent(id)}`);
    assertOperation(result);
    return result;
  }
  async world(id: string): Promise<World> {
    const result = await this.json("GET", `/worlds/${encodeURIComponent(id)}`);
    assertWorld(result);
    return result;
  }
  async credits(): Promise<number> {
    const response = await this.json("GET", "/credits");
    if (!response || typeof response !== "object" || !("remaining_credits" in response) ||
        typeof response.remaining_credits !== "number") {
      throw new Error("Unexpected credits response");
    }
    return response.remaining_credits;
  }
}
export function parseRetryAfter(value: string): number | null {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  const ms = Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : null;
}
