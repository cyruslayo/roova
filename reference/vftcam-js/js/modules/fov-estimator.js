import { Hotspots } from './hotspots.js';

const FovEstimator = {
    async estimateFOV(captures, options = {}) {
        const {
            minFOV = 40,
            maxFOV = 80,
            iterations = 14,
            sampleWidth = 640,
            overlapWidth = 64,
            debugMode = false
        } = options;

        console.log(`Starting FOV estimation: ${minFOV}° to ${maxFOV}°`);

        const pairs = await this.selectOverlapPairs(captures);
        if (pairs.length < 3) {
            console.warn('Not enough overlap pairs for FOV estimation');
            return 67;
        }

        let a = minFOV, b = maxFOV;
        const phi = 0.61803398875;
        let c = b - phi * (b - a);
        let d = a + phi * (b - a);

        let fc = await this.scoreAtFOV(c, pairs, sampleWidth, overlapWidth);
        let fd = await this.scoreAtFOV(d, pairs, sampleWidth, overlapWidth);

        for (let i = 0; i < iterations; i++) {
            if (fc > fd) {
                b = d;
                d = c;
                fd = fc;
                c = b - phi * (b - a);
                fc = await this.scoreAtFOV(c, pairs, sampleWidth, overlapWidth);
            } else {
                a = c;
                c = d;
                fc = fd;
                d = a + phi * (b - a);
                fd = await this.scoreAtFOV(d, pairs, sampleWidth, overlapWidth);
            }

            if (debugMode && i % 3 === 0) {
                console.log(`Iteration ${i}: FOV range [${a.toFixed(1)}°, ${b.toFixed(1)}°]`);
            }
        }

        const estimatedFOV = (a + b) / 2;
        console.log(`Estimated FOV: ${estimatedFOV.toFixed(1)}°`);

        const aspectRatio = 9 / 16;
        const vFOV = 2 * Math.atan(Math.tan(estimatedFOV * Math.PI / 360) / aspectRatio) * 180 / Math.PI;
        console.log(`Horizontal FOV: ${estimatedFOV.toFixed(1)}°, Vertical FOV: ${vFOV.toFixed(1)}°`);

        return {
            horizontal: estimatedFOV,
            vertical: vFOV
        };
    },

    async selectOverlapPairs(captures) {
        const pairs = [];
        const matchingGraph = Hotspots.getMatchingGraph();

        for (const [hotspotId, capture] of captures.entries()) {
            if (!capture) continue;

            const neighborIds = matchingGraph[hotspotId] || [];
            for (const neighborId of neighborIds) {
                const neighborIdNum = parseInt(neighborId);
                if (neighborIdNum > hotspotId && captures.has(neighborIdNum)) {
                    pairs.push({
                        imgA: capture,
                        idA: hotspotId,
                        imgB: captures.get(neighborIdNum),
                        idB: neighborIdNum
                    });
                }
            }
        }

        return pairs.slice(0, Math.min(pairs.length, 12));
    },

    async scoreAtFOV(fovDeg, pairs, sampleWidth, overlapWidth) {
        let totalScore = 0;
        let validPairs = 0;

        for (const pair of pairs) {
            const score = await this.computePairScore(pair, fovDeg, sampleWidth, overlapWidth);
            if (score > 0) {
                totalScore += score;
                validPairs++;
            }
        }

        return validPairs > 0 ? totalScore / validPairs : 0;
    },

    async computePairScore(pair, fovDeg, targetWidth, overlapWidth) {
        const { imgA, idA, imgB, idB } = pair;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        const aspectRatio = imgA.height / imgA.width;
        canvas.width = targetWidth;
        canvas.height = Math.floor(targetWidth * aspectRatio);

        ctx.drawImage(imgA.imageData, 0, 0, canvas.width, canvas.height);
        const dataA = ctx.getImageData(0, 0, canvas.width, canvas.height);

        ctx.drawImage(imgB.imageData, 0, 0, canvas.width, canvas.height);
        const dataB = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const overlapRegion = this.calculateOverlapRegion(
            imgA.yaw, imgA.pitch,
            imgB.yaw, imgB.pitch,
            fovDeg
        );

        if (!overlapRegion) return 0;

        const stripA = this.extractStrip(dataA, overlapRegion, overlapWidth);
        const stripB = this.extractStrip(dataB, overlapRegion, overlapWidth);

        return this.computeZNCC(stripA, stripB);
    },

    calculateOverlapRegion(yawA, pitchA, yawB, pitchB, fovDeg) {
        const fovRad = fovDeg * Math.PI / 180;
        const halfFov = fovRad / 2;

        const yawDiff = Math.abs(yawA - yawB);
        const pitchDiff = Math.abs(pitchA - pitchB);

        const adjustedYawDiff = Math.min(yawDiff, 360 - yawDiff);

        if (adjustedYawDiff * Math.PI / 180 > fovRad ||
            pitchDiff * Math.PI / 180 > fovRad) {
            return null;
        }

        const overlapFraction = 1 - (adjustedYawDiff * Math.PI / 180) / fovRad;

        let xStart, xEnd;
        if (yawB > yawA || (yawA > 270 && yawB < 90)) {
            xStart = 1 - overlapFraction * 0.5;  // Increased from 0.3 to 0.5 for better sampling
            xEnd = 1;
        } else {
            xStart = 0;
            xEnd = overlapFraction * 0.5;  // Increased from 0.3 to 0.5
        }

        return { xStart, xEnd, yStart: 0.3, yEnd: 0.7 };  // Narrower vertical band
    },

    extractStrip(imageData, region, stripWidth) {
        const { xStart, xEnd, yStart, yEnd } = region;
        const { width, height, data } = imageData;

        const x1 = Math.floor(xStart * width);
        const x2 = Math.min(Math.floor(xEnd * width), x1 + stripWidth);
        const y1 = Math.floor(yStart * height);
        const y2 = Math.floor(yEnd * height);

        const stripData = [];
        for (let y = y1; y < y2; y++) {
            for (let x = x1; x < x2; x++) {
                const idx = (y * width + x) * 4;
                const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
                stripData.push(gray);
            }
        }

        return stripData;
    },

    computeZNCC(stripA, stripB) {
        if (stripA.length !== stripB.length || stripA.length === 0) return 0;

        const n = stripA.length;
        let sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0;

        for (let i = 0; i < n; i++) {
            sumA += stripA[i];
            sumB += stripB[i];
            sumAA += stripA[i] * stripA[i];
            sumBB += stripB[i] * stripB[i];
            sumAB += stripA[i] * stripB[i];
        }

        const meanA = sumA / n;
        const meanB = sumB / n;

        const varA = sumAA / n - meanA * meanA;
        const varB = sumBB / n - meanB * meanB;
        const covar = sumAB / n - meanA * meanB;

        if (varA <= 0 || varB <= 0) return 0;

        const zncc = covar / Math.sqrt(varA * varB);
        return Math.max(0, zncc);
    },

    async refineAlignment(captures, estimatedFOV, options = {}) {
        const {
            iterations = 3,
            maxDeltaYaw = 2,
            maxDeltaPitch = 2,
            maxDeltaRoll = 2
        } = options;

        console.log('Starting pose refinement...');

        const refinedCaptures = new Map(captures);
        const pairs = await this.selectOverlapPairs(captures);

        for (let iter = 0; iter < iterations; iter++) {
            let totalAdjustment = 0;

            for (const pair of pairs) {
                const adjustment = await this.computePoseAdjustment(
                    pair,
                    estimatedFOV,
                    maxDeltaYaw,
                    maxDeltaPitch,
                    maxDeltaRoll
                );

                if (adjustment) {
                    const capture = refinedCaptures.get(pair.idB);
                    capture.actualYaw += adjustment.deltaYaw;
                    capture.actualPitch += adjustment.deltaPitch;
                    capture.roll += adjustment.deltaRoll;

                    totalAdjustment += Math.abs(adjustment.deltaYaw) +
                                     Math.abs(adjustment.deltaPitch) +
                                     Math.abs(adjustment.deltaRoll);
                }
            }

            console.log(`Refinement iteration ${iter + 1}: total adjustment = ${totalAdjustment.toFixed(2)}°`);

            if (totalAdjustment < 0.1) break;
        }

        return refinedCaptures;
    },

    async computePoseAdjustment(pair, fovDeg, maxDeltaYaw, maxDeltaPitch, maxDeltaRoll) {
        const currentScore = await this.computePairScore(pair, fovDeg, 640, 64);

        const step = 0.1;
        const derivatives = {};

        for (const param of ['yaw', 'pitch', 'roll']) {
            const modifiedPair = { ...pair };
            const modifiedImg = { ...pair.imgB };

            if (param === 'yaw') modifiedImg.actualYaw += step;
            else if (param === 'pitch') modifiedImg.actualPitch += step;
            else modifiedImg.roll += step;

            modifiedPair.imgB = modifiedImg;
            const score = await this.computePairScore(modifiedPair, fovDeg, 640, 64);
            derivatives[param] = (score - currentScore) / step;
        }

        const scale = 0.5;
        return {
            deltaYaw: Math.max(-maxDeltaYaw, Math.min(maxDeltaYaw, derivatives.yaw * scale)),
            deltaPitch: Math.max(-maxDeltaPitch, Math.min(maxDeltaPitch, derivatives.pitch * scale)),
            deltaRoll: Math.max(-maxDeltaRoll, Math.min(maxDeltaRoll, derivatives.roll * scale))
        };
    }
};

export default FovEstimator;