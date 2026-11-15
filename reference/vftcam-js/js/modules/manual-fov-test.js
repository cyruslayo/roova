// Manual FOV testing utility
// This allows you to visually test different FOV values to find the best match

export const ManualFOVTest = {
    testFOV(fovValue) {
        // Store the test FOV value
        sessionStorage.setItem('overrideFOV', fovValue.toString());
        sessionStorage.removeItem('overrideVFOV'); // Clear vertical override
        console.log(`FOV test set to ${fovValue}°`);
        console.log('Now reload and stitch to see the result');
        return fovValue;
    },

    testHV(hFov, vFov) {
        // Test specific horizontal and vertical FOV values
        sessionStorage.setItem('overrideFOV', hFov.toString());
        sessionStorage.setItem('overrideVFOV', vFov.toString());
        console.log(`Testing H=${hFov}° V=${vFov}°`);
        console.log('Now reload and stitch to see the result');
        return { h: hFov, v: vFov };
    },

    adjustV(vFov) {
        // Adjust only vertical FOV, keeping horizontal as-is
        const currentH = sessionStorage.getItem('overrideFOV') || '45';
        sessionStorage.setItem('overrideVFOV', vFov.toString());
        console.log(`Vertical FOV set to ${vFov}° (keeping H=${currentH}°)`);
        console.log('Now reload and stitch to see the result');
        return vFov;
    },

    quickTest() {
        // Quick test of common vertical adjustments
        const h = parseFloat(sessionStorage.getItem('overrideFOV') || '45');
        const baseV = 2 * Math.atan(Math.tan(h * Math.PI / 360) * (16/9)) * 180 / Math.PI;

        console.log(`Current H=${h}°, calculated V=${baseV.toFixed(1)}°\n`);
        console.log('Quick vertical adjustments:');
        console.log(`  ManualFOVTest.adjustV(${(baseV - 2).toFixed(1)})  // -2°`);
        console.log(`  ManualFOVTest.adjustV(${(baseV - 1).toFixed(1)})  // -1°`);
        console.log(`  ManualFOVTest.adjustV(${baseV.toFixed(1)})  // baseline`);
        console.log(`  ManualFOVTest.adjustV(${(baseV + 1).toFixed(1)})  // +1°`);
        console.log(`  ManualFOVTest.adjustV(${(baseV + 2).toFixed(1)})  // +2°`);
        console.log(`  ManualFOVTest.adjustV(${(baseV + 3).toFixed(1)})  // +3°`);
        console.log('\nFine tuning:');
        console.log(`  ManualFOVTest.testHV(${h}, yourVFOV)  // Set both H and V`);
    },

    testRange() {
        const results = [];
        console.log('=== FOV Test Guide ===');
        console.log('Test each value and look for the one with:');
        console.log('- Minimal ghosting at seams');
        console.log('- Best alignment of features');
        console.log('- No doubling of objects\n');

        const testValues = [41, 41.5, 42, 42.5, 43, 43.5, 44, 44.5, 45];

        console.log('Try these commands:');
        testValues.forEach(fov => {
            console.log(`ManualFOVTest.testFOV(${fov})`);
        });

        console.log('\nCurrent override:', sessionStorage.getItem('overrideFOV') || 'none');
        console.log('To clear override: sessionStorage.removeItem("overrideFOV")');
    },

    analyzeGhosting(fovValue) {
        // This would analyze the stitched result for ghosting
        // For now, just a placeholder
        console.log(`To analyze ghosting at FOV ${fovValue}°:`);
        console.log('1. Look at tree branches - are they doubled?');
        console.log('2. Check water reflections - are they aligned?');
        console.log('3. Examine straight lines - do they continue smoothly?');
        console.log('4. Look for duplicate features at seams');
    },

    setPitchCorrection(degrees) {
        // Set a global pitch correction for systematic vertical misalignment
        sessionStorage.setItem('pitchCorrection', degrees.toString());
        console.log(`Pitch correction set to ${degrees}°`);
        console.log('Positive values move images up, negative values move them down');
        console.log('Now reload and stitch to see the result');
        return degrees;
    },

    testPitchCorrection() {
        console.log('=== Pitch Correction Test ===');
        console.log('If all images are consistently too high or too low:');
        console.log('');
        console.log('Try these commands:');
        console.log('  ManualFOVTest.setPitchCorrection(-3)  // Move all images down 3°');
        console.log('  ManualFOVTest.setPitchCorrection(-2)  // Move all images down 2°');
        console.log('  ManualFOVTest.setPitchCorrection(-1)  // Move all images down 1°');
        console.log('  ManualFOVTest.setPitchCorrection(0)   // No correction (default)');
        console.log('  ManualFOVTest.setPitchCorrection(1)   // Move all images up 1°');
        console.log('  ManualFOVTest.setPitchCorrection(2)   // Move all images up 2°');
        console.log('  ManualFOVTest.setPitchCorrection(3)   // Move all images up 3°');
        console.log('');
        console.log('Current correction:', sessionStorage.getItem('pitchCorrection') || '0');
        console.log('To clear: sessionStorage.removeItem("pitchCorrection")');
    }
};

// Make it globally available for console testing
window.ManualFOVTest = ManualFOVTest;