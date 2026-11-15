export type StitchLayer = {
  name: string; hotspotId: number; yaw: number; pitch: number; roll: number;
  canvas: HTMLCanvasElement; hasFullOrientation: boolean;
};
export type SkyReference = { width: number; height: number; rgba: Uint8ClampedArray };
export class VftcamStitcher {
  _stitchLog: string[];
  _skyReference: SkyReference | null;
  _zenithDiagnostics: unknown[];
  projectToCamera(worldDir: { x: number; y: number; z: number }, layer: { yaw: number; pitch: number; roll?: number }, tanHalfHF: number, tanHalfVF: number): { u: number; v: number } | null;
  renderBestPixelPanorama(gl: WebGL2RenderingContext, erpCanvas: HTMLCanvasElement, layers: StitchLayer[], calibratedFOV: { horizontal: number; vertical: number }, seamAlignments?: unknown[]): Promise<void>;
  applySkyReference(finalCanvas: HTMLCanvasElement, ref: SkyReference, strength?: number): void;
}
