// VFTCam FOV calibrator (reference/vftcam-js/js/modules/fov-calibrator.js).
// Product change: the 9:16 aspect constants take the frames' real aspect.
import { Hotspots } from './hotspots.js';

const FovCalibrator = {
    async calibrateFromCaptures(captures, options = {}) {
        const {
            testFOVs = [40, 42, 44, 46, 48, 50, 52],  // Test range around 44°
            sampleSize = 512,  // Downsample for speed
            debug = false,
            expectedFOV = 44,  // Prior expectation for FOV
            aspect = 16 / 9  // Product change: frame height/width (reference assumed 9:16)
        } = options;
        this._aspect = aspect;

        console.log('Starting FOV calibration from actual captures...');

        // Prepare downsampled captures for faster processing
        const processedCaptures = await this.prepareCaptures(captures, sampleSize);

        // Find adjacent pairs with good overlap
        const testPairs = this.selectTestPairs(processedCaptures);

        if (testPairs.length < 3) {
            console.warn('Not enough overlap pairs for calibration');
            return null;
        }

        console.log(`Testing FOVs: ${testFOVs.join('°, ')}° with ${testPairs.length} image pairs`);

        // Test each FOV and score the alignment quality
        const scores = [];
        for (const fov of testFOVs) {
            const alignmentScore = await this.scoreFOV(fov, testPairs, sampleSize);

            // Add prior bias towards expected FOV (Gaussian prior)
            const priorWeight = 0.1;  // How much to weight the prior
            const priorScore = Math.exp(-Math.pow(fov - expectedFOV, 2) / (2 * 9));  // Gaussian with σ=3°

            const finalScore = alignmentScore * (1 - priorWeight) + priorScore * priorWeight;

            scores.push({ fov, score: finalScore, alignmentScore, priorScore });

            if (debug) {
                console.log(`FOV ${fov}°: alignment=${alignmentScore.toFixed(3)}, prior=${priorScore.toFixed(3)}, final=${finalScore.toFixed(3)}`);
            }
        }

        // Find the FOV with the best score
        const best = scores.reduce((a, b) => a.score > b.score ? a : b);
        console.log(`Best FOV: ${best.fov}° (score: ${best.score.toFixed(3)}, alignment: ${best.alignmentScore.toFixed(3)})`);

        // Show all scores if confidence is low
        if (best.alignmentScore < 0.4) {
            console.log('Low confidence - all scores:');
            scores.forEach(s => {
                console.log(`  ${s.fov}°: alignment=${s.alignmentScore.toFixed(3)}`);
            });
        }

        // Calculate vertical FOV from horizontal (9:16 portrait aspect)
        // For portrait: VFOV = 2 * atan(tan(HFOV/2) * (height/width))
        const aspectRatio = this._aspect;  // Height/Width ratio of the actual frames
        const vFOV = 2 * Math.atan(Math.tan(best.fov * Math.PI / 360) * aspectRatio) * 180 / Math.PI;
        console.log(`Portrait mode: H=${best.fov}° -> V=${vFOV.toFixed(1)}° (aspect ratio ${aspectRatio.toFixed(2)})`);

        return {
            horizontal: best.fov,
            vertical: vFOV,
            confidence: best.score,
            scores: scores
        };
    },

    async prepareCaptures(captures, targetSize) {
        const processed = new Map();

        for (const [id, capture] of captures.entries()) {
            if (!capture) continue;

            // Create downsampled canvas
            const canvas = document.createElement('canvas');
            canvas.width = targetSize;
            canvas.height = Math.floor(targetSize * this._aspect);  // Maintain the frames' aspect

            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(capture.imageData, 0, 0, canvas.width, canvas.height);

            processed.set(id, {
                canvas: canvas,
                ctx: ctx,
                yaw: capture.yaw || capture.actualYaw,
                pitch: capture.pitch || capture.actualPitch,
                roll: capture.roll || 0,
                id: id
            });
        }

        return processed;
    },

    selectTestPairs(captures) {
        const pairs = [];
        const matchingGraph = Hotspots.getMatchingGraph();

        // Get horizontal neighbors (30° apart)
        // With FOV ~44°, these should have about 14° overlap (44° - 30° = 14°)
        const horizontalPairs = [
            [1, 2], [2, 3], [3, 4],    // Upper row samples
            [13, 14], [14, 15], [15, 16], // Equator samples
            [25, 26], [26, 27], [27, 28]  // Lower row samples
        ];

        for (const [idA, idB] of horizontalPairs) {
            if (captures.has(idA) && captures.has(idB)) {
                pairs.push({
                    a: captures.get(idA),
                    b: captures.get(idB),
                    angularSeparation: 30  // degrees
                });
            }
        }

        return pairs;
    },

    async scoreFOV(fovDeg, pairs, imageSize) {
        let totalScore = 0;
        let validPairs = 0;

        for (const pair of pairs) {
            const score = await this.scorePairAlignment(fovDeg, pair, imageSize);
            if (score > 0) {
                totalScore += score;
                validPairs++;
            }
        }

        return validPairs > 0 ? totalScore / validPairs : 0;
    },

    async scorePairAlignment(fovDeg, pair, imageSize) {
        const { a, b } = pair;

        // Calculate where images should overlap based on this FOV
        const overlapRegion = this.calculateOverlapRegion(
            a.yaw, a.pitch,
            b.yaw, b.pitch,
            fovDeg
        );

        if (!overlapRegion) return 0;

        // Extract overlapping regions from both images
        const regionA = this.extractRegion(a, overlapRegion.aRegion);
        const regionB = this.extractRegion(b, overlapRegion.bRegion);

        // Compare the regions using multiple metrics
        const rgbScore = this.compareRGB(regionA, regionB);
        const gradientScore = this.compareGradients(regionA, regionB);
        const structureScore = this.compareStructure(regionA, regionB);

        // Weighted combination of scores
        return rgbScore * 0.3 + gradientScore * 0.4 + structureScore * 0.3;
    },

    calculateOverlapRegion(yawA, pitchA, yawB, pitchB, fovDeg) {
        // Convert to radians
        const fovRad = fovDeg * Math.PI / 180;
        const halfFov = fovRad / 2;

        // Calculate angular separation
        let deltaYaw = (yawB - yawA) * Math.PI / 180;

        // Handle wraparound
        if (deltaYaw > Math.PI) deltaYaw -= 2 * Math.PI;
        if (deltaYaw < -Math.PI) deltaYaw += 2 * Math.PI;

        const deltaPitch = (pitchB - pitchA) * Math.PI / 180;

        // For portrait mode (9:16), vertical FOV is larger
        // Using the correct portrait aspect ratio
        const aspectRatio = this._aspect;  // Height/Width of the actual frames
        const vFovRad = 2 * Math.atan(Math.tan(halfFov) * aspectRatio);

        // Check if images should overlap with this FOV
        if (Math.abs(deltaYaw) > fovRad || Math.abs(deltaPitch) > vFovRad) {
            return null;  // No overlap
        }

        // Calculate overlap regions in normalized image coordinates
        // This represents how much of each image overlaps
        const overlapWidth = (fovRad - Math.abs(deltaYaw)) / fovRad;
        const overlapHeight = (vFovRad - Math.abs(deltaPitch)) / vFovRad;

        // Region in image A (right side if B is to the right)
        const aRegion = {
            x: deltaYaw > 0 ? 1 - overlapWidth : 0,
            y: deltaPitch > 0 ? 1 - overlapHeight : 0,
            width: overlapWidth,
            height: overlapHeight
        };

        // Region in image B (left side if B is to the right)
        const bRegion = {
            x: deltaYaw > 0 ? 0 : 1 - overlapWidth,
            y: deltaPitch < 0 ? 1 - overlapHeight : 0,
            width: overlapWidth,
            height: overlapHeight
        };

        return { aRegion, bRegion };
    },

    extractRegion(capture, region) {
        const { ctx, canvas } = capture;
        const x = Math.floor(region.x * canvas.width);
        const y = Math.floor(region.y * canvas.height);
        const width = Math.floor(region.width * canvas.width);
        const height = Math.floor(region.height * canvas.height);

        // Clamp to canvas bounds
        const safeX = Math.max(0, Math.min(x, canvas.width - 1));
        const safeY = Math.max(0, Math.min(y, canvas.height - 1));
        const safeWidth = Math.min(width, canvas.width - safeX);
        const safeHeight = Math.min(height, canvas.height - safeY);

        if (safeWidth <= 0 || safeHeight <= 0) {
            return null;
        }

        return ctx.getImageData(safeX, safeY, safeWidth, safeHeight);
    },

    compareRGB(dataA, dataB) {
        if (!dataA || !dataB) return 0;

        // Resize to same dimensions if needed
        const minWidth = Math.min(dataA.width, dataB.width);
        const minHeight = Math.min(dataA.height, dataB.height);

        // Require minimum overlap size to avoid false matches
        if (minWidth < 20 || minHeight < 20) return 0;

        let sumDiff = 0;
        let count = 0;

        for (let y = 0; y < minHeight; y++) {
            for (let x = 0; x < minWidth; x++) {
                const idxA = (y * dataA.width + x) * 4;
                const idxB = (y * dataB.width + x) * 4;

                const dr = dataA.data[idxA] - dataB.data[idxB];
                const dg = dataA.data[idxA + 1] - dataB.data[idxB + 1];
                const db = dataA.data[idxA + 2] - dataB.data[idxB + 2];

                sumDiff += Math.sqrt(dr * dr + dg * dg + db * db);
                count++;
            }
        }

        // Convert to similarity score (1 = perfect match, 0 = no match)
        const avgDiff = sumDiff / count;
        return Math.exp(-avgDiff / 50);  // Exponential decay
    },

    compareGradients(dataA, dataB) {
        if (!dataA || !dataB) return 0;

        const gradA = this.computeGradients(dataA);
        const gradB = this.computeGradients(dataB);

        const minLen = Math.min(gradA.x.length, gradB.x.length);

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < minLen; i++) {
            dotProduct += gradA.x[i] * gradB.x[i] + gradA.y[i] * gradB.y[i];
            normA += gradA.x[i] * gradA.x[i] + gradA.y[i] * gradA.y[i];
            normB += gradB.x[i] * gradB.x[i] + gradB.y[i] * gradB.y[i];
        }

        if (normA === 0 || normB === 0) return 0;

        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    },

    computeGradients(imageData) {
        const { width, height, data } = imageData;
        const gradX = [];
        const gradY = [];

        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = (y * width + x) * 4;

                // Convert to grayscale
                const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];

                // Sobel operators
                const idxLeft = (y * width + x - 1) * 4;
                const idxRight = (y * width + x + 1) * 4;
                const idxUp = ((y - 1) * width + x) * 4;
                const idxDown = ((y + 1) * width + x) * 4;

                const grayLeft = 0.299 * data[idxLeft] + 0.587 * data[idxLeft + 1] + 0.114 * data[idxLeft + 2];
                const grayRight = 0.299 * data[idxRight] + 0.587 * data[idxRight + 1] + 0.114 * data[idxRight + 2];
                const grayUp = 0.299 * data[idxUp] + 0.587 * data[idxUp + 1] + 0.114 * data[idxUp + 2];
                const grayDown = 0.299 * data[idxDown] + 0.587 * data[idxDown + 1] + 0.114 * data[idxDown + 2];

                gradX.push((grayRight - grayLeft) / 2);
                gradY.push((grayDown - grayUp) / 2);
            }
        }

        return { x: gradX, y: gradY };
    },

    compareStructure(dataA, dataB) {
        if (!dataA || !dataB) return 0;

        // Compute local binary patterns or simple structure metrics
        const structA = this.extractStructure(dataA);
        const structB = this.extractStructure(dataB);

        let matches = 0;
        const minLen = Math.min(structA.length, structB.length);

        for (let i = 0; i < minLen; i++) {
            if (Math.abs(structA[i] - structB[i]) < 0.1) {
                matches++;
            }
        }

        return matches / minLen;
    },

    extractStructure(imageData) {
        const { width, height, data } = imageData;
        const structure = [];

        // Simple local variance as structure metric
        const blockSize = 4;

        for (let by = 0; by < height - blockSize; by += blockSize) {
            for (let bx = 0; bx < width - blockSize; bx += blockSize) {
                let sum = 0;
                let sumSq = 0;
                let count = 0;

                for (let y = by; y < by + blockSize && y < height; y++) {
                    for (let x = bx; x < bx + blockSize && x < width; x++) {
                        const idx = (y * width + x) * 4;
                        const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
                        sum += gray;
                        sumSq += gray * gray;
                        count++;
                    }
                }

                const mean = sum / count;
                const variance = (sumSq / count) - (mean * mean);
                structure.push(Math.sqrt(Math.max(0, variance)) / 128);  // Normalized
            }
        }

        return structure;
    }
};

export default FovCalibrator;