type Spatial = { metricScaleFactor?: number | null; groundPlaneOffset?: number | null } | null | undefined;

export function spatialTransform(spatial: Spatial) {
  return {
    metricScaleFactor: Number.isFinite(spatial?.metricScaleFactor) && spatial!.metricScaleFactor! > 0 ? spatial!.metricScaleFactor! : 1,
    groundPlaneOffset: Number.isFinite(spatial?.groundPlaneOffset) ? spatial!.groundPlaneOffset! : 0,
    rotationX: Math.PI
  };
}
