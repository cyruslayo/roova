/** Minimal adapter contract derived from World Labs Marble v1 OpenAPI.
 * Source: https://docs.worldlabs.ai/api/reference/openapi
 * This is NOT a generated full-spec SDK. Regenerate and reconcile when pinning the actual YAML.
 */
export type AssetKind = "video";
export interface UploadInfo {
  upload_url: string;
  upload_method: string;
  required_headers?: Record<string, string> | null;
}
export interface PrepareUploadResponse {
  media_asset: { media_asset_id: string; [key: string]: unknown };
  upload_info: UploadInfo;
}
export interface OperationCost {
  total_credits: number;
  line_items?: { name: string; credits: number }[];
}
export interface OperationError {
  code?: number | null;
  message?: string | null;
}
export interface Operation {
  operation_id: string;
  done: boolean;
  metadata?: Record<string, unknown> | null;
  response?: unknown;
  error?: OperationError | null;
  cost?: OperationCost | null;
  created_at?: string | null;
  updated_at?: string | null;
  expires_at?: string | null;
}
export interface World {
  world_id: string;
  display_name: string;
  world_marble_url: string;
  assets?: {
    thumbnail_url?: string | null;
    imagery?: { pano_url?: string | null } | null;
    splats?: {
      spz_urls?: Record<string, string> | null;
      semantics_metadata?: {
        metric_scale_factor?: number | null;
        ground_plane_offset?: number | null;
      } | null;
    } | null;
    mesh?: { collider_mesh_url?: string | null } | null;
    caption?: string | null;
  } | null;
}
export interface GenerateVideoInput {
  mediaAssetId: string;
  displayName: string;
  model?: "marble-1.1" | "marble-1.1-plus" | "marble-1.0" | "marble-1.0-draft";
}
export type SourceCandidate = { name: string; url: string; kind: "poster" | "panorama" | "spz" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function assertUpload(value: unknown): asserts value is PrepareUploadResponse {
  if (!isRecord(value) || !isRecord(value.media_asset) ||
      typeof value.media_asset.media_asset_id !== "string" ||
      !isRecord(value.upload_info) ||
      typeof value.upload_info.upload_url !== "string" ||
      typeof value.upload_info.upload_method !== "string") {
    throw new Error("World Labs upload response does not match expected contract");
  }
}
export function assertOperation(value: unknown): asserts value is Operation {
  if (!isRecord(value) || typeof value.operation_id !== "string" || typeof value.done !== "boolean") {
    throw new Error("World Labs operation does not match expected contract");
  }
}
export function assertWorld(value: unknown): asserts value is World {
  if (!isRecord(value) || typeof value.world_id !== "string" ||
      typeof value.display_name !== "string" || typeof value.world_marble_url !== "string") {
    throw new Error("World Labs world does not match expected contract");
  }
}
export function worldIdFromOperation(operation: Operation): string | null {
  if (!operation.done || operation.error) return null;
  if (isRecord(operation.response) && typeof operation.response.world_id === "string") {
    return operation.response.world_id;
  }
  if (isRecord(operation.metadata) && typeof operation.metadata.world_id === "string") {
    return operation.metadata.world_id;
  }
  return null;
}
export function assetCandidates(world: World): SourceCandidate[] {
  const assets = world.assets;
  if (!assets) return [];
  const all: SourceCandidate[] = [];
  if (assets.thumbnail_url) all.push({ kind: "poster", name: "poster", url: assets.thumbnail_url });
  if (assets.imagery?.pano_url) all.push({ kind: "panorama", name: "panorama", url: assets.imagery.pano_url });
  for (const tier of ["100k", "500k"]) {
    const url = assets.splats?.spz_urls?.[tier];
    if (url) all.push({ kind: "spz", name: tier, url });
  }
  return all;
}
export function sceneFacts(world: World): { metricScaleFactor: number | null; groundPlaneOffset: number | null } {
  const m = world.assets?.splats?.semantics_metadata;
  return {
    metricScaleFactor: typeof m?.metric_scale_factor === "number" && Number.isFinite(m.metric_scale_factor) ? m.metric_scale_factor : null,
    groundPlaneOffset: typeof m?.ground_plane_offset === "number" && Number.isFinite(m.ground_plane_offset) ? m.ground_plane_offset : null,
  };
}
export function validateFileInput(name: string, bytes: number): { extension: string; mime: string } {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", avi: "video/x-msvideo"
  };
  const mime = types[extension];
  if (!mime) throw new Error("Unsupported video format; use MP4, MOV, WebM, or AVI");
  // Conservative decimal MB interpretation of the documented 100MB limit.
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 100_000_000) {
    throw new Error("Video must be greater than 0 and at most 100,000,000 bytes");
  }
  return { extension, mime };
}
