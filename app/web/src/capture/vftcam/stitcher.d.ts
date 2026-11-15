export type StitchLayer = {
  name: string; hotspotId: number; yaw: number; pitch: number; roll: number;
  canvas: HTMLCanvasElement; hasFullOrientation: boolean;
};
export type SkyReference = { width: number; height: number; rgba: Uint8ClampedArray };
export type AlignInfo = {
  stage: string; frames: number; reason?: string; corners?: number[];
  pairsTried?: number; matchesFound?: number; pairsMatched?: number; matchesKept?: number;
  focal?: { focal: number; measured: number; consistent: number; far: number }[];
};
export class VftcamStitcher {
  _stitchLog: string[];
  _skyReference: SkyReference | null;
  _zenithDiagnostics: unknown[];
  _alignInfo: AlignInfo | null;
  projectToCamera(worldDir: { x: number; y: number; z: number }, layer: { yaw: number; pitch: number; roll?: number }, tanHalfHF: number, tanHalfVF: number): { u: number; v: number } | null;
  renderBestPixelPanorama(gl: WebGL2RenderingContext, erpCanvas: HTMLCanvasElement, layers: StitchLayer[], calibratedFOV: { horizontal: number; vertical: number }, seamAlignments?: unknown[]): Promise<void>;
  applySkyReference(finalCanvas: HTMLCanvasElement, ref: SkyReference, strength?: number): void;
}
