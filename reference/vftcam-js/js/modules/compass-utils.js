/**
 * Compass Utilities for Cross-Platform Heading Detection
 * Handles iOS webkitCompassHeading, Android deviceorientationabsolute,
 * and fallback calculations from Euler angles
 */

export class CompassUtils {
    constructor() {
        // Utility functions
        this.deg = r => r * 180 / Math.PI;
        this.rad = d => d * Math.PI / 180;
        this.clamp360 = x => (x % 360 + 360) % 360;
        
        // Smoothing filter
        this.smoothingAlpha = 0.15;
        this.smoothedHeading = null;
        
        // User calibration offset
        this.userOffset = 0;
        
        // Current raw and processed headings
        this.currentHeading = null;
        this.hasAbsoluteOrientation = false;
        
        // Callbacks
        this.onHeadingUpdate = null;
        
        // Track if we're listening
        this.isListening = false;
    }
    
    /**
     * Simple low-pass filter for smoothing
     */
    smoothHeading(value) {
        if (this.smoothedHeading === null) {
            this.smoothedHeading = value;
        } else {
            this.smoothedHeading = this.smoothingAlpha * value + 
                                   (1 - this.smoothingAlpha) * this.smoothedHeading;
        }
        return this.smoothedHeading;
    }
    
    /**
     * Correct heading for current screen orientation
     */
    applyScreenOrientation(headingDeg) {
        const angle = (screen.orientation && screen.orientation.angle) || 
                     window.orientation || 0;
        return this.clamp360(headingDeg + (typeof angle === 'number' ? angle : 0));
    }
    
    /**
     * Compute compass heading from alpha/beta/gamma (when no absolute heading exposed)
     * Based on W3C examples; returns degrees [0..360)
     */
    computeHeadingFromEuler(alpha, beta, gamma) {
        // Convert to radians
        const a = this.rad(alpha), b = this.rad(beta), g = this.rad(gamma);
        
        // Rotation matrix components
        const cA = Math.cos(a), sA = Math.sin(a);
        const cB = Math.cos(b), sB = Math.sin(b);
        const cG = Math.cos(g), sG = Math.sin(g);
        
        // ZXY rotation
        const m11 = cA * cG - sA * sB * sG;
        const m12 = -cB * sA;
        
        // Heading is the device's yaw relative to magnetic north (approx)
        let heading = Math.atan2(m12, m11);
        heading = this.deg(heading);
        return this.clamp360(heading);
    }
    
    /**
     * Best-effort normalization of an event to a compass heading (deg)
     */
    normalizeHeading(e) {
        // 1) iOS Safari gives absolute north directly
        if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
            this.hasAbsoluteOrientation = true;
            // iOS reports clockwise degrees from North already
            return e.webkitCompassHeading;
        }
        
        // 2) deviceorientationabsolute (alpha=0 at true north)
        if (e.absolute === true && typeof e.alpha === 'number') {
            this.hasAbsoluteOrientation = true;
            // Many implementations define alpha clockwise from North
            return this.clamp360(360 - e.alpha); // Note: some devices need this inverted
        }
        
        // 3) deviceorientation with alpha relative to initial pose
        if (typeof e.alpha === 'number' && typeof e.beta === 'number' && typeof e.gamma === 'number') {
            this.hasAbsoluteOrientation = false;
            // Try deriving from Euler angles (less accurate)
            return this.computeHeadingFromEuler(e.alpha, e.beta, e.gamma);
        }
        
        return null;
    }
    
    /**
     * Handle orientation event
     */
    handleOrientation(e) {
        let heading = this.normalizeHeading(e);
        
        if (heading == null) {
            console.warn('No usable orientation data.');
            return;
        }
        
        // Apply screen orientation correction
        heading = this.applyScreenOrientation(heading);
        
        // Apply user calibration offset
        heading = this.clamp360(heading + this.userOffset);
        
        // Apply smoothing
        heading = this.smoothHeading(heading);
        
        // Store current heading
        this.currentHeading = heading;
        
        // Notify callback
        if (this.onHeadingUpdate) {
            this.onHeadingUpdate(Math.round(heading), this.hasAbsoluteOrientation);
        }
    }
    
    /**
     * Start listening for orientation events
     */
    startListening() {
        if (this.isListening) return;
        
        // Bind handler
        this.boundHandler = (e) => this.handleOrientation(e);
        
        // Prefer deviceorientationabsolute when present
        const useAbsolute = 'ondeviceorientationabsolute' in window;
        
        if (useAbsolute) {
            console.log('Using deviceorientationabsolute event');
            window.addEventListener('deviceorientationabsolute', this.boundHandler, true);
        } else {
            console.log('Using deviceorientation event');
            window.addEventListener('deviceorientation', this.boundHandler, true);
        }
        
        this.isListening = true;
    }
    
    /**
     * Stop listening for orientation events
     */
    stopListening() {
        if (!this.isListening) return;
        
        window.removeEventListener('deviceorientationabsolute', this.boundHandler, true);
        window.removeEventListener('deviceorientation', this.boundHandler, true);
        
        this.isListening = false;
    }
    
    /**
     * iOS 13+ needs a user gesture to grant access
     */
    async requestIOSPermission() {
        const needsPermission = typeof DeviceOrientationEvent !== 'undefined' &&
                                typeof DeviceOrientationEvent.requestPermission === 'function';
        
        if (!needsPermission) {
            this.startListening();
            return { granted: true, message: 'No permission needed' };
        }
        
        try {
            const state = await DeviceOrientationEvent.requestPermission();
            
            if (state === 'granted') {
                this.startListening();
                console.log('Device orientation permission granted.');
                return { granted: true, message: 'Permission granted' };
            } else {
                console.warn('Device orientation permission denied:', state);
                return { granted: false, message: `Permission ${state}` };
            }
        } catch (err) {
            console.error('Permission request failed:', err);
            return { granted: false, message: err.message };
        }
    }
    
    /**
     * Set user calibration offset
     * @param {number} targetNorth - The direction that should be north (0)
     */
    calibrateToNorth(targetNorth = 0) {
        if (this.currentHeading === null) {
            console.warn('No heading available for calibration');
            return false;
        }
        
        this.userOffset = this.clamp360(targetNorth - this.currentHeading);
        console.log(`Compass calibrated: offset=${this.userOffset.toFixed(1)}°`);
        return true;
    }
    
    /**
     * Get current compass heading
     */
    getHeading() {
        return this.currentHeading ? Math.round(this.currentHeading) : null;
    }
    
    /**
     * Check if we have absolute orientation (true compass)
     */
    hasCompass() {
        return this.hasAbsoluteOrientation;
    }
}