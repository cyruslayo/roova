import { assetCandidates, sceneFacts, type World, type Operation } from "./contract.js";
export interface StoredAsset { name: string; relativePath: string; bytes: number; contentType: string }
export interface ViewerManifest {
  version: 1;
  published: false;
  worldId: string;
  title: string;
  poster: string | null;
  panorama: string | null;
  splats: Record<string, string>;
  spatial: { metricScaleFactor: number | null; groundPlaneOffset: number | null };
  creditsCharged: number | null;
  needsOperatorReview: true;
}
export function buildManifest(world: World, operation: Operation, stored: StoredAsset[]): ViewerManifest {
  const found = new Map(stored.map(x => [x.name, x]));
  const required = assetCandidates(world).some(x => x.kind === "spz");
  if (!required || !stored.some(x => x.name === "100k" || x.name === "500k")) {
    throw new Error("No usable mobile SPZ available; scene is not publishable");
  }
  const splats: Record<string, string> = {};
  for (const tier of ["100k", "500k"]) {
    const asset = found.get(tier);
    if (asset) splats[tier] = asset.relativePath;
  }
  return {
    version: 1, published: false,
    worldId: world.world_id, title: world.display_name,
    poster: found.get("poster")?.relativePath ?? null,
    panorama: found.get("panorama")?.relativePath ?? null,
    splats,
    spatial: sceneFacts(world),
    creditsCharged: typeof operation.cost?.total_credits === "number" ? operation.cost.total_credits : null,
    needsOperatorReview: true
  };
}
