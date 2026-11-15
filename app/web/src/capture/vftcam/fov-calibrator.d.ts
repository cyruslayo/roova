declare const FovCalibrator: {
  calibrateFromCaptures(captures: Map<number, { imageData: HTMLCanvasElement; yaw: number; pitch: number; actualYaw: number; actualPitch: number; roll: number; width: number; height: number }>,
    options: { testFOVs: number[]; expectedFOV: number; aspect: number; debug?: boolean }): Promise<{ horizontal: number; vertical: number; confidence: number } | null>;
};
export default FovCalibrator;
