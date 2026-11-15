export const cameraLimits = { minYaw: -1.35, maxYaw: 1.35, minPitch: -0.55, maxPitch: 0.65, minZoom: 0.72, maxZoom: 1.48 } as const;
export function constrainLook(yaw: number, pitch: number, zoom: number) {
  return {
    yaw: Math.min(cameraLimits.maxYaw, Math.max(cameraLimits.minYaw, yaw)),
    pitch: Math.min(cameraLimits.maxPitch, Math.max(cameraLimits.minPitch, pitch)),
    zoom: Math.min(cameraLimits.maxZoom, Math.max(cameraLimits.minZoom, zoom))
  };
}
