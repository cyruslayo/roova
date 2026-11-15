/**
 * Super lightweight alignment using just roll data and simple edge detection
 * Fast enough for mobile, no FFT or complex operations
 */

export class SimpleAligner {
    constructor() {
        this.sampleSize = 256; // Larger sample to handle bigger offsets
    }

    /**
     * Quick alignment using consensus horizon approach
     */
    async calculateAlignments(images) {
        const alignments = [];

        console.log(`Calculating alignments for ${images.length} images`);
        console.log('First image:', images[0] ? {
            hotspotId: images[0].hotspotId,
            hasCanvas: !!images[0].canvas,
            hasBitmap: !!images[0].bitmap,
            roll: images[0].roll
        } : 'no images');

        // Calculate the "consensus horizon" - median roll across all images
        const allRolls = images.map(img => img.roll || 0);
        allRolls.sort((a, b) => a - b);
        const medianRoll = allRolls[Math.floor(allRolls.length / 2)];

        console.log(`📏 Consensus horizon: ${(medianRoll * 180 / Math.PI).toFixed(2)}° (median tilt from ${allRolls.length} images)`);

        // Process all images, storing roll compensation
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            const nextImg = images[(i + 1) % images.length];

            // Roll difference from consensus
            const rollDelta = (img.roll || 0) - medianRoll;

            // This is the key insight: we store the roll compensation amount
            // The shader will use this to counter-rotate each image to level it
            const rollCompensation = -rollDelta; // Keep in radians for shader

            // Skip horizontal alignment for now - it's not working well
            const horizontal = 0; // await this.quickHorizontalTest(img, nextImg);

            alignments.push({
                from: img.hotspotId,
                to: nextImg.hotspotId,
                horizontal: horizontal,
                vertical: 0, // We're using rotation instead of vertical shift!
                rollCompensation: rollCompensation, // THIS IS THE KEY!
                method: 'consensus-horizon'
            });

            console.log(`Seam ${img.hotspotId} → ${nextImg.hotspotId}: horizontal=${horizontal}px, roll=${(rollCompensation * 180 / Math.PI).toFixed(1)}°`);
        }

        return alignments;
    }

    /**
     * Very quick horizontal alignment test
     */
    async quickHorizontalTest(img1, img2) {
        try {
            // Get small sample from overlap region
            const sample1 = this.getQuickSample(img1, 'right');
            const sample2 = this.getQuickSample(img2, 'left');

            if (!sample1 || !sample2) {
                console.warn(`Could not get samples for ${img1.hotspotId} → ${img2.hotspotId}`);
                return 0;
            }

            // Calculate average brightness to ensure we have actual image data
            let avg1 = 0, avg2 = 0;
            for (let i = 0; i < Math.min(100, sample1.length); i++) {
                avg1 += sample1[i];
                avg2 += sample2[i];
            }
            avg1 /= Math.min(100, sample1.length);
            avg2 /= Math.min(100, sample2.length);

            console.log(`Samples ${img1.hotspotId}→${img2.hotspotId}: size=${sample1.length}, avg brightness: ${avg1.toFixed(0)}, ${avg2.toFixed(0)}`);

            // Test a wider range of offsets for better alignment
            // Including large offsets up to 150 pixels for significant misalignments
            let bestOffset = 0;
            let bestScore = this.quickCompare(sample1, sample2, 0);
            let scoreAtZero = bestScore;
            let allScores = [];

            // Coarse search first (big steps)
            const coarseOffsets = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150];
            for (const offset of coarseOffsets) {
                const score = this.quickCompare(sample1, sample2, offset);
                allScores.push({offset, score});
                if (score > bestScore) {
                    bestScore = score;
                    bestOffset = offset;
                }
            }

            // Log all scores to see if there's any variation
            const scoreRange = Math.max(...allScores.map(s => s.score)) - Math.min(...allScores.map(s => s.score));
            console.log(`Score range for ${img1.hotspotId}→${img2.hotspotId}: ${scoreRange.toFixed(1)} (best=${bestScore.toFixed(1)} at ${bestOffset}px)`);

            if (scoreRange < 1) {
                console.warn(`No variation in scores - samples might be uniform or misaligned`);
                // Log a few scores for debugging
                console.log('Sample scores:', allScores.slice(0, 3).map(s => `${s.offset}px:${s.score.toFixed(1)}`).join(', '));
            }

            // Fine search around the best coarse offset
            const coarseBest = bestOffset;
            for (const delta of [-20, -10, -5, 5, 10, 20]) {
                const offset = coarseBest + delta;
                if (offset >= -150 && offset <= 150) {
                    const score = this.quickCompare(sample1, sample2, offset);
                    if (score > bestScore) {
                        bestScore = score;
                        bestOffset = offset;
                    }
                }
            }

            return bestOffset;
        } catch (e) {
            console.warn('Quick horizontal test failed:', e);
            return 0;
        }
    }

    /**
     * Get a sample from image edge for alignment
     */
    getQuickSample(img, side) {
        try {
            let canvas;

            if (img.canvas) {
                canvas = img.canvas;
            } else if (img.bitmap) {
                // Convert bitmap to canvas for sampling
                canvas = document.createElement('canvas');
                canvas.width = img.bitmap.width;
                canvas.height = img.bitmap.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img.bitmap, 0, 0);
            } else {
                console.warn('No canvas or bitmap in image:', img.hotspotId);
                return null;
            }

            const ctx = canvas.getContext('2d');
            const w = Math.min(this.sampleSize, Math.floor(canvas.width / 3)); // Sample up to 1/3 of width for better overlap
            const h = Math.min(this.sampleSize, Math.floor(canvas.height / 2)); // Don't sample more than 1/2 of height

            // Sample from middle height, edge of image
            const x = side === 'right' ? canvas.width - w : 0;
            const y = Math.floor((canvas.height - h) / 2);

            console.log(`Sampling ${side} edge of image ${img.hotspotId}: ${w}x${h} at (${x},${y}) from ${canvas.width}x${canvas.height}`);

            const imageData = ctx.getImageData(x, y, w, h);

            // Check if we got actual image data (not all black/white)
            let minVal = 255, maxVal = 0;
            const gray = new Uint8Array(w * h);
            for (let i = 0, j = 0; i < imageData.data.length; i += 4, j++) {
                const val = (imageData.data[i] + imageData.data[i + 1] + imageData.data[i + 2]) / 3;
                gray[j] = val;
                minVal = Math.min(minVal, val);
                maxVal = Math.max(maxVal, val);
            }

            const range = maxVal - minVal;
            if (range < 10) {
                console.warn(`Sample from ${img.hotspotId} ${side} has very low contrast: range=${range}`);
            }

            return gray;
        } catch (e) {
            console.error('Error getting sample:', e);
            return null;
        }
    }

    /**
     * Super quick comparison of two samples
     */
    quickCompare(sample1, sample2, offset) {
        if (!sample1 || !sample2) return 0;

        let sum = 0;
        let count = 0;
        const size = this.sampleSize;

        // Compare overlapping regions considering the offset
        // When offset > 0, we're shifting sample2 to the right
        // So we compare the right part of sample1 with the left part of sample2
        const startX = Math.max(0, offset);
        const endX = Math.min(size, size + offset);

        if (startX >= endX) {
            // No overlap at this offset
            return 0;
        }

        // Compare the overlapping region
        for (let y = 0; y < size; y++) {
            for (let x = startX; x < endX; x++) {
                const idx1 = y * size + x;
                const idx2 = y * size + (x - offset);

                if (idx1 >= 0 && idx1 < sample1.length && idx2 >= 0 && idx2 < sample2.length) {
                    const diff = Math.abs(sample1[idx1] - sample2[idx2]);
                    sum += (255 - diff); // Higher score for better match
                    count++;
                }
            }
        }

        return count > 0 ? sum / count : 0;
    }
}