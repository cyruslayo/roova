/**
 * ============================================================================
 * MAIN APPLICATION CONTROLLER - VFTCam Photosphere Capture
 * ============================================================================
 * 
 * This is the central orchestrator for the entire 360° photosphere capture app.
 * It coordinates a complex pipeline between device sensors, camera, 3D graphics,
 * and GPU processing to create seamless panoramic images.
 * 
 * THE CAPTURE WORKFLOW:
 * ----------------------
 * 1. User holds phone in portrait orientation
 * 2. App shows 36 orange dots in a sphere around them
 * 3. As they turn, dots turn green when aligned
 * 4. Auto-captures when aligned and level for 1 second
 * 5. After 37 captures, stitches into equirectangular panorama
 * 
 * KEY TECHNICAL CONCEPTS:
 * -----------------------
 * - HOTSPOTS: 36 predefined capture points (3 rows × 12 columns)
 * - ALIGNMENT: Uses 3D angle calculation, not 2D projection
 * - AUTO-CAPTURE: Triggers when aligned (±4.6°) and level (±2°)
 * - BEST-PIXEL: GPU shader selects sharpest pixel from overlaps
 * - PORTRAIT MODE: 9:16 aspect ratio critical for proper coverage
 * 
 * DEPENDENCIES:
 * -------------
 * - Three.js: 3D visualization and camera management
 * - WebRTC: Camera access via getUserMedia
 * - DeviceOrientation/Motion APIs: Phone position tracking
 * - IndexedDB: Local storage for captured images
 * - WebGL2: GPU acceleration for stitching
 * 
 * MEMORY MANAGEMENT:
 * ------------------
 * - iOS: Limited to 720×1280 captures (Safari memory limits)
 * - Android: Full 1080×1920 captures
 * - Smart image loader with 50-image cache
 * - Immediate cleanup after GPU processing
 * 
 * @module app
 * @author Reuben Thiessen
 * @version 1.2.0
 */

// Core module imports
import { Database } from './database.js';
import { Camera } from './camera.js';
import { Scene } from './scene.js';
import { computeSeamLabels, boxDown, whitePoint } from './seam-finder.js';
import { capturePose, poseFromQuaternion } from './capture-orientation.js';
import { recoverZenithRoll } from './zenith-alignment.js';
import { Hotspots } from './hotspots.js';
import FovEstimator from './fov-estimator.js';
import FovCalibrator from './fov-calibrator.js';
import { ManualFOVTest } from './manual-fov-test.js';
import { Stitcher } from './stitching.js';
import { SmartImageLoader, MemoryMonitor, panoramaThumb } from './memory-utils.js';
import { Debug } from './debug.js';
// OpenCV removed - using WebGL2 for all stitching operations
import { metadataUtils } from './metadata-utils.js';
import { CameraRoll } from './camera-roll.js';
import { CardUI } from './card-ui.js';
import { PixelatedTransition } from './pixelated-transition.js';
import { photoSphereSharer } from './share-utils.js';
import { photosphereStamp } from './frame-export.js';
import { DeviceDetector } from './device-detector.js';
import { fillPolesSimple } from './pole-fill-simple.js';
import { PermissionsManager } from './permissions.js';
import { StitchProcessor } from './stitch-processor.js';
const EQUATOR_PORTRAIT_FOV_DEG = 72; // try 72 first; if still squished, try 70; if stretched, try 75

export class PhotosphereApp {
    
    constructor() {
        // ============================================
        // CORE MODULE INSTANCES
        // ============================================
        
        // Database singleton for IndexedDB operations (stores captured images)
        this.database = new Database();
        
        // Camera module handles WebRTC getUserMedia and image capture
        this.camera = new Camera(this);
        
        // Three.js scene for 3D visualization (initialized after DOM ready)
        this.scene = null;
        
        // WebGL2 stitcher is now the only method
        this.stitcher = new Stitcher();
        
        // Worker-based stitch processor for heavy operations
        this.stitchProcessor = null; // Will be initialized after DOM ready
        
        // Smart memory management - caches up to 50 images to prevent iOS crashes
        this.imageLoader = new SmartImageLoader(50);
        this.memoryMonitor = new MemoryMonitor();
        
        // Debug panel for development/testing
        this.debug = new Debug(this.database);
        
        // UI components (initialized after DOM ready to ensure elements exist)
        this.cameraRoll = null;     // Gallery of saved photospheres
        this.cardUI = null;         // Glass-morphic card interface system
        this.deviceDetector = null; // Mobile device and orientation detection
        this.permissions = null;    // Permissions manager for camera, motion, location
        
        // ============================================
        // CAPTURE STATE MANAGEMENT
        // ============================================
        
        // The 36 predefined capture points arranged in a sphere
        // 3 rows: upper (+45°), equator (0°), lower (-45°)
        // 12 points per row at 30° intervals
        this.hotspots = Hotspots.getHotspots();
        
        // Tracks which of the 37 points have been captured
        this.capturedHotspots = new Set();
        
        // Currently targeted hotspot (null when not near any)
        this.currentHotspot = null;
        
        // True when device is aligned with a hotspot (within ~4.6°)
        this.isAligned = false;
        
        // Timer for auto-capture countdown (fires after 1 second of alignment)
        this.alignmentTimer = null;
        
        // Prevents multiple simultaneous captures
        this.isCapturing = false;
        
        // Master switch - disabled until user clicks "Start Capturing"
        this.isCapturingEnabled = false;
        
        // Flag to track if we're handling permission dialogs
        this.isHandlingPermissions = false;
        
        // Flag to track if we're recovering from an interrupted stitch
        this.isRecoveringStitch = false;
        
        // ============================================
        // DEVICE ORIENTATION TRACKING
        // ============================================
        
        // Current device orientation from DeviceOrientationEvent
        // alpha: rotation around z-axis (compass heading) 0-360°
        // beta: rotation around x-axis (tilt forward/back) -180 to 180°
        // gamma: rotation around y-axis (tilt left/right) -90 to 90°
        this.deviceOrientation = {
            alpha: 0,
            beta: 0,
            gamma: 0,
            absolute: false
        };
        
        // Compass tracking for real-world alignment
        // When absolute is true, alpha is the compass heading (0° = North)
        this.compassOffset = null; // Offset between device orientation and real compass
        this.firstCaptureCompassHeading = null; // Compass heading of first capture
        this.compassUtils = null; // Will be loaded when needed for better iOS support
        
        // Stitch recovery for handling iOS Safari crashes
        this.stitchRecovery = null; // Will be loaded in init()
        this.currentStitchJobId = null; // Track current stitch job
        
        // Smoothing for the roll/level indicator
        // We average the last 10 accelerometer readings to reduce jitter
        this.rollHistory = [];
        this.rollHistorySize = 10;
        
        // Current device tilt from accelerometer (more reliable than gamma)
        this.deviceTilt = 0;
        
        // ============================================
        // DOM ELEMENT REFERENCES
        // ============================================
        
        // Cache of frequently accessed DOM elements (populated in init())
        this.elements = {};
        
        // ============================================
        // CONFIGURATION CONSTANTS
        // ============================================
        
        // How long user must hold position before auto-capture (milliseconds)
        this.CAPTURE_DELAY = 1000;
        // Roll (sideways tilt) allowed at capture, degrees. Was 2 before the
        // image alignment and per-frame roll handling made it unnecessary.
        this.LEVEL_TOLERANCE = 8;
        
        // ============================================
        // CAPTURE RESOLUTION CONFIGURATION
        // ============================================
        
        // Allow debug override via sessionStorage for testing different resolutions
        const testResolution = sessionStorage.getItem('captureResolution');
        if (testResolution) {
            try {
                this.CAPTURE_RESOLUTION = JSON.parse(testResolution);
                console.log('Using test resolution:', this.CAPTURE_RESOLUTION);
            } catch (e) {
                this.CAPTURE_RESOLUTION = { width: 1080, height: 1920 };
            }
        } else {
            // Portrait orientation (9:16 aspect ratio) is critical for proper overlap
            // The 37-point pattern assumes portrait FOV for adequate coverage
            
            // iOS devices have strict memory limits that cause crashes with large images
            // Safari on iOS will kill the page if memory usage exceeds ~1.4GB
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                         (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
            
            if (isIOS) {
                // 720p portrait for iOS - prevents memory crashes
                // Still produces good quality panoramas
                this.CAPTURE_RESOLUTION = {
                    width: 720,
                    height: 1280
                };
                console.log('Using reduced resolution for iOS:', this.CAPTURE_RESOLUTION);
            } else {
                // 1080p portrait for Android/Desktop - maximum quality
                this.CAPTURE_RESOLUTION = {
                    width: 1080,
                    height: 1920
                };
            }
            console.log('Portrait capture resolution:', this.CAPTURE_RESOLUTION);
        }
    }

    /**
     * Initialize the application after DOM is ready
     * This is the main entry point called from capture.js
     * 
     * Initialization sequence:
     * 1. Set up IndexedDB for image storage
     * 2. Cache DOM element references
     * 3. Create Three.js 3D scene
     * 4. Initialize camera (but don't start it yet)
     * 5. Set up UI components
     * 6. Check for mobile device compatibility
     * 7. Start render loop
     * 
     * @async
     * @throws {Error} If critical elements are missing from DOM
     */
    async init() {
        // Update loading progress if available
        if (window.LoadingScreen) {
            window.LoadingScreen.updateProgress(55, 'Initializing database...', 'Setting up storage');
        }
        
        // Initialize IndexedDB first (needed for everything)
        await this.database.init();
        
        if (window.LoadingScreen) {
            window.LoadingScreen.updateProgress(60, 'Loading interface...', 'Preparing elements');
        }
        
        // Cache all DOM elements we'll need to manipulate
        this.elements = {
            sceneContainer: document.getElementById('scene-container'),
            cameraViewport: document.getElementById('camera-viewport'),
            alignmentIndicator: document.getElementById('alignment-indicator'),
            videoFull: document.getElementById('camera-full'),
            captureCanvas: document.getElementById('capture-canvas'),
            captureBtn: document.getElementById('capture-btn-container'),
            captureCheckmark: document.getElementById('captureCheckmark'),
            progressPath: document.getElementById('progressPath'),
            instructions: document.getElementById('instructions'),
            stitchBtn: document.getElementById('stitch-btn'),
            clearBtn: document.getElementById('clear-btn'),
            stitchingOverlay: document.getElementById('stitching-overlay'),
            progressBar: document.getElementById('stitch-progress-bar'),
            statusText: document.getElementById('stitch-status'),
            statusDetails: document.getElementById('stitch-details'),
            previewCanvas: document.getElementById('preview-canvas')
        };
        
        // Create Three.js 3D scene for visualizing capture progress
        // This shows a wireframe sphere with the 37 capture points
        if (!this.elements.sceneContainer) {
            console.error('Scene container not found!');
            throw new Error('Scene container element not found');
        }
        // Initialize 3D scene with error handling
        if (window.LoadingScreen) {
            window.LoadingScreen.updateProgress(65, 'Creating 3D scene...', 'Initializing visualization');
        }
        
        try {
            if (typeof THREE === 'undefined') {
                throw new Error('Three.js not loaded');
            }
            this.scene = new Scene(this.elements.sceneContainer);
        } catch (error) {
            console.error('Failed to initialize 3D scene:', error);
            // Continue without 3D visualization - app can still work
            this.scene = null;
        }
        
        // Initialize camera WITHOUT requesting permissions yet
        // Permissions will be requested when user clicks "Start Capturing"
        if (window.LoadingScreen) {
            window.LoadingScreen.updateProgress(70, 'Setting up camera...', 'Preparing capture system');
        }
        await this.camera.init(this.elements.videoFull, this.elements.captureCanvas, false);
        
        // Initialize UI components
        if (window.LoadingScreen) {
            window.LoadingScreen.updateProgress(75, 'Loading UI components...', 'Creating interface');
        }
        this.cameraRoll = new CameraRoll(this);      // Gallery of saved panoramas
        this.cardUI = new CardUI(this);              // Glass-morphic card system
        this.permissions = new PermissionsManager(this); // Permissions manager
        console.log('Permissions manager initialized:', this.permissions);
        
        // Show warning if private browsing detected
        if (this.database.isPrivateBrowsing) {
            await this.cardUI.alert(
                'Private browsing mode detected. The app may not be able to save images or panoramas. Please use a regular browser window for full functionality.',
                'Private Browsing Warning'
            );
        }
        
        // Initialize stitch processor for worker-based processing
        if (window.LoadingScreen) {
            window.LoadingScreen.updateProgress(78, 'Setting up processor...', 'Initializing stitch engine');
        }
        this.stitchProcessor = new StitchProcessor(this);
        
        // Check for interrupted stitches but DON'T show dialog yet
        // Just save the state for later
        let pendingStitchRecovery = false;
        try {
            const { stitchRecovery } = await import('./stitch-recovery.js');
            this.stitchRecovery = stitchRecovery;
            this.stitchRecovery.init(this, this.database);
            
            // Check if there's an interrupted stitch but don't act on it yet
            const hasInterrupted = await this.stitchRecovery.hasInterruptedStitch();
            if (hasInterrupted) {
                console.log('Interrupted stitch detected, will handle after init');
                pendingStitchRecovery = true;
            }
        } catch (error) {
            console.warn('Stitch recovery check failed:', error);
        }
        
        // Check if device is mobile and show warning if not
        // Also handles orientation detection and locking
        if (window.LoadingScreen) {
            window.LoadingScreen.updateProgress(80, 'Detecting device...', 'Checking capabilities');
        }
        this.deviceDetector = new DeviceDetector(this);
        await this.deviceDetector.init();
        
        // Wire up all event handlers (device orientation, buttons, etc.)
        if (window.LoadingScreen) {
            window.LoadingScreen.updateProgress(85, 'Setting up controls...', 'Binding event handlers');
        }
        this.setupEventListeners();
        
        // Start the Three.js render loop (60fps animation)
        this.animate();
        
        // Hide capture UI elements on start screen (unless we're recovering a stitch)
        if (this.scene && !this.isRecoveringStitch) {
            this.scene.showStartScreenState();
        }
        
        // Enable debug panel if ?debug=true in URL
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('debug') === 'true') {
            this.debug.enable();
        }
        
        // NOTE: We don't clear previous session on init anymore
        // This allows users to continue a partial capture after reload
        
        console.log('Photosphere app initialized');
        
        // App initialization complete - progress will be finalized in capture.js
        // Now handle any pending stitch recovery after init is complete
        if (pendingStitchRecovery) {
            // Let the loading screen finish hiding first
            setTimeout(async () => {
                const recoveryAction = await this.stitchRecovery.checkAndRecover();
                if (recoveryAction === 'retry') {
                    console.log('Retrying interrupted stitch');
                    this.isRecoveringStitch = true;
                } else if (recoveryAction === 'discard') {
                    console.log('Discarded interrupted stitch');
                }
            }, 500);
        }
        
        return pendingStitchRecovery;  // Return this so capture.js knows
    }

    /**
     * Set up all event listeners for user interaction and device sensors
     * 
     * Event categories:
     * 1. Device orientation - tracks phone rotation for alignment
     * 2. Device motion - detects if phone is level (for stable capture)
     * 3. Button clicks - capture, clear, stitch operations
     * 4. Debug events - for testing without real capture
     * 5. Keyboard shortcuts - spacebar to capture, Ctrl+S to stitch
     */
    setupEventListeners() {
        // ============================================
        // DEVICE SENSOR EVENTS
        // ============================================
        
        // DeviceOrientationEvent gives us the phone's rotation in 3D space
        // We use this to point the virtual camera at hotspots
        if (window.DeviceOrientationEvent) {
            window.addEventListener('deviceorientation', (e) => this.handleOrientation(e));
        }
        
        // DeviceMotionEvent gives us accelerometer data
        // We use this to detect if the phone is level (not tilted)
        // This is more reliable than using gamma from orientation
        if (window.DeviceMotionEvent) {
            window.addEventListener('devicemotion', (e) => this.handleMotion(e));
        }
        
        this.elements.stitchBtn?.addEventListener('click', () => this.startStitching());
        this.elements.clearBtn?.addEventListener('click', async () => { 
            if(this.cardUI && await this.cardUI.confirm('Clear all captured images and return to start?', 'Clear Session?')) {
                await this.clearSession();
            }
        });
        // ============================================
        // CAPTURE BUTTON - DUAL PURPOSE
        // ============================================
        // 
        // The capture button (green circle) has two modes:
        // 1. During capture: exit current capture session and start stitching with images captured so far (partial capture)
        // 2. After capture: Start stitching process
        // 
        // The button shows a progress ring that fills as images are captured
        // At 37/37 it turns into a checkmark to indicate ready to stitch
        
        this.elements.captureBtn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.elements.captureBtn.click(); }
        });
        this.elements.captureBtn.addEventListener('click', async () => {
            const capturedCount = this.capturedHotspots.size;
            
            if (capturedCount > 0) {
                // We have some images - button should start stitching
                
                if (capturedCount < Hotspots.TOTAL_HOTSPOTS) {
                    // Incomplete capture - warn user
                    const proceed = this.cardUI && await this.cardUI.confirm(
                        `You have captured ${capturedCount} out of ${Hotspots.TOTAL_HOTSPOTS} images.\n\nThe panorama may be incomplete. Do you want to continue to stitching?`,
                        'Incomplete Capture'
                    );
                    if (!proceed) {
                        // User wants to continue capturing
                        this.handleCapture();
                        return;
                    }
                }
                
                // Start the WebGL2 best-pixel stitching pipeline
                this.startBestPixelStitching();
            } else {
                // No images yet - try to capture at current position
                this.handleCapture();
            }
        });
        // start-btn already has onclick in HTML
        document.getElementById('close-stitch-overlay-btn').addEventListener('click', async () => { 
            // Check if this is a partial capture
            const capturedCount = this.capturedHotspots.size;
            const totalCount = Hotspots.TOTAL_HOTSPOTS;
            
            if (capturedCount > 0 && capturedCount < totalCount) {
                // Partial capture - give user a choice
                const message = `You have captured ${capturedCount} of ${totalCount} images.\n\n` +
                    `Would you like to:\n` +
                    `• Continue capturing (only works well if you're still in the same location)\n` +
                    `• Start over with a new capture session\n\n` +
                    `Choose "Continue" to keep capturing, "Start Over" to begin fresh.`;
                
                const continueCapture = this.cardUI && await this.cardUI.showDialog({
                    title: 'Partial Capture',
                    message: message,
                    type: 'confirm',
                    confirmText: 'Continue',
                    cancelText: 'Start Over'
                });
                
                // Close the overlay with animation
                this.elements.stitchingOverlay.classList.remove('lifting-in');
                this.elements.stitchingOverlay.classList.add('pressing-down');
                setTimeout(() => {
                    this.elements.stitchingOverlay.classList.remove('visible', 'pressing-down');
                }, 300);
                
                if (continueCapture) {
                    // Continue capturing - re-enable capture mode
                    this.setCapturingEnabled(true);
                    
                    // Show the capture UI elements
                    document.getElementById('scene-container').style.display = 'block';
                    document.getElementById('camera-viewport').style.display = 'block';
                    document.getElementById('alignment-indicator').style.display = 'block';
                    document.getElementById('instructions').style.display = 'block';
                    const bottomControls = document.querySelector('.bottom-controls');
                    if (bottomControls) bottomControls.style.display = 'flex';
                    
                    // Show the hotspots and patches
                    if (this.scene) {
                        this.scene.showCaptureState();
                    }
                    
                    // Make sure camera is running
                    if (this.camera && !this.camera.stream) {
                        this.camera.startCamera();
                    }
                } else {
                    // Start over - clear session and show start screen
                    this.clearSession();
                    // Show start screen
                    const startScreen = document.getElementById('start-screen');
                    if (startScreen) {
                        startScreen.style.display = 'block';
                    }
                    // Hide capture UI
                    document.getElementById('scene-container').style.display = 'none';
                    document.getElementById('camera-viewport').style.display = 'none';
                    document.getElementById('alignment-indicator').style.display = 'none';
                    document.getElementById('instructions').style.display = 'none';
                    document.querySelector('.bottom-controls').style.display = 'none';
                }
            } else {
                // Full capture or no images - just close
                this.elements.stitchingOverlay.classList.remove('lifting-in');
                this.elements.stitchingOverlay.classList.add('pressing-down');
                setTimeout(() => {
                    this.elements.stitchingOverlay.classList.remove('visible', 'pressing-down');
                }, 300);
                
                if (capturedCount === totalCount) {
                    // Full capture complete - clear session and go to start
                    this.clearSession(true);
                    const startScreen = document.getElementById('start-screen');
                    if (startScreen) {
                        startScreen.style.display = 'block';
                    }
                    document.getElementById('scene-container').style.display = 'none';
                    document.getElementById('camera-viewport').style.display = 'none';
                    document.getElementById('alignment-indicator').style.display = 'none';
                    document.getElementById('instructions').style.display = 'none';
                    document.querySelector('.bottom-controls').style.display = 'none';
                }
            }
        });
                
        // ============================================
        // DEBUG PANEL EVENTS
        // ============================================
        
        // Fired when debug panel clears all data
        window.addEventListener('debug-data-cleared', () => {
            this.capturedHotspots.clear();
            this.scene.clearCapturedPatches();
            this.updateProgress();
        });
        
        // Fired when debug panel wants to test stitching
        window.addEventListener('debug-test-stitch', () => {
            this.startStitching();
        });
        
        // ============================================
        // KEYBOARD SHORTCUTS (Desktop Testing)
        // ============================================
        
        document.addEventListener('keydown', (e) => {
            if (e.key === ' ') {
                // Spacebar - manual capture
                e.preventDefault();
                this.handleCapture();
            } else if (e.key === 's' && e.ctrlKey) {
                // Ctrl+S - start stitching
                e.preventDefault();
                this.startStitching();
            }
        });
    }

    // Helper method for screen reader announcements
    announceToScreenReader(message) {
        const announcer = document.getElementById('sr-announcements');
        if (announcer) {
            announcer.textContent = message;
            // Clear after a short delay to allow re-announcement of same message
            setTimeout(() => {
                announcer.textContent = '';
            }, 100);
        }
    }

    async handleOrientation(event) {
        // Store raw device orientation
        this.deviceOrientation = {
            alpha: event.alpha || 0,
            beta: event.beta || 0,
            gamma: event.gamma || 0,
            absolute: event.absolute
        };
        
        // Initialize CompassUtils for better iOS support if not already done
        if (!this.compassUtils) {
            try {
                const { CompassUtils } = await import('./compass-utils.js');
                this.compassUtils = new CompassUtils();
                // Don't auto-start listening here - let permissions card handle it
            } catch (err) {
                console.warn('CompassUtils not available, using basic orientation');
            }
        }
        
        // Check for iOS webkitCompassHeading
        if (typeof event.webkitCompassHeading === 'number' && !isNaN(event.webkitCompassHeading)) {
            // iOS provides true compass heading directly
            this.deviceOrientation.absolute = true;
            this.deviceOrientation.compassHeading = event.webkitCompassHeading;
            
            if (this.compassOffset === null) {
                this.compassOffset = event.webkitCompassHeading;
                console.log(`iOS Compass calibrated: heading=${event.webkitCompassHeading.toFixed(1)}°`);
            }
        } else if (event.absolute && this.compassOffset === null) {
            // Android/desktop with absolute orientation
            this.compassOffset = event.alpha || 0;
            console.log(`Compass calibrated: offset=${this.compassOffset.toFixed(1)}° (absolute orientation available)`);
        }
        
        // Update camera rotation
        if (this.scene) {
            this.scene.updateCameraRotation(
                this.deviceOrientation.alpha,
                this.deviceOrientation.beta,
                this.deviceOrientation.gamma
            );
        }
        
        // Note: Roll indicator is now updated by handleMotion using accelerometer
        
        // Check alignment with hotspots
        this.checkAlignment();
    }
    
    handleMotion(event) {
        // Use accelerometer data for more reliable tilt detection
        const accel = event.accelerationIncludingGravity;
        if (!accel) return;
        
        // When phone is upright (portrait mode):
        // x-axis: left/right tilt (what we need for roll)
        // y-axis: gravity pulls down (~-9.8 when upright)
        // z-axis: forward/backward tilt
        
        // Calculate tilt angle from x-axis acceleration
        // Gravity is ~9.8 m/s², x component indicates tilt
        // sin(angle) = x / 9.8
        const tiltAngle = Math.asin(Math.max(-1, Math.min(1, accel.x / 9.8))) * (180 / Math.PI);
        
        // Update roll indicator with accelerometer-based tilt
        this.updateRollIndicator(tiltAngle);
    }
    
    updateRollIndicator(tiltAngle) {
        const rollLine = document.getElementById('roll-line-moving');
        if (!rollLine) return;
        
        // Add to history for smoothing
        this.rollHistory.push(tiltAngle);
        if (this.rollHistory.length > this.rollHistorySize) {
            this.rollHistory.shift();
        }
        
        // Calculate smoothed average
        const smoothedTilt = this.rollHistory.reduce((a, b) => a + b, 0) / this.rollHistory.length;
        this.deviceTilt = smoothedTilt;
        
        // Apply counter-rotation to keep line level with horizon
        const displayRotation = -smoothedTilt;
        rollLine.style.transform = `translateY(-50%) rotate(${displayRotation}deg)`;
        
        // Change color based on how level the device is
        const isLevel = Math.abs(smoothedTilt) < this.LEVEL_TOLERANCE;
        const isTilted = Math.abs(smoothedTilt) > this.LEVEL_TOLERANCE + 4;
        
        rollLine.classList.toggle('level', isLevel);
        rollLine.classList.toggle('tilted', isTilted && !isLevel);
    }
    
    /**
     * Check if device is level enough for capture
     * 
     * Each frame's measured roll is applied geometrically in the stitcher and
     * the image alignment corrects the residual, so roll only costs a little
     * overlap. The tolerance is loose enough to hold without effort (kids,
     * one-handed); it keeps frames from being rolled so far that the capture
     * grid's overlaps shrink.
     * Uses accelerometer data which is more reliable than gyro
     * 
     * @returns {boolean} True if device tilt is within acceptable range
     */
    isDeviceLevel() {
        // Near the zenith, lens-axis rotation is captured by the full camera
        // quaternion. The gravity-based level indicator cannot measure that
        // twist, and gating on it can block aiming. Skip this UI check there.
        if (this.currentHotspot && Math.abs(this.currentHotspot.pitch) > 60) return true;
        return Math.abs(this.deviceTilt) < this.LEVEL_TOLERANCE;
    }
    
    normalizeAngleDelta(delta) {
        // Normalize angle difference to -180 to 180 range
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;
        return delta;
    }

    checkAlignment() {
        // Don't check alignment if capturing is disabled
        if (!this.isCapturingEnabled) {
            return;
        }
        
        // Get camera direction vector
        const cameraDirection = new THREE.Vector3(0, 0, -1);
        cameraDirection.applyQuaternion(this.scene.camera.quaternion);
        
        let nearestHotspot = null;
        let nearestDistance = Infinity;
        
        // Find nearest uncaptured hotspot using 3D angle
        this.hotspots.forEach(hotspot => {
            if (!this.capturedHotspots.has(hotspot.id)) {
                const hotspotPosition = this.scene.hotspotToPosition(hotspot.yaw, hotspot.pitch);
                const direction = hotspotPosition.clone().normalize();
                const angle = cameraDirection.angleTo(direction);
                
                if (angle < nearestDistance) {
                    nearestDistance = angle;
                    nearestHotspot = hotspot;
                }
            }
        });
        
        // Update alignment state
        // APPROACH_THRESHOLD - when to show the indicator (orange)
        // ALIGNMENT_THRESHOLD - when to allow capture (green)
        const APPROACH_THRESHOLD = 0.25; // ~14 degrees - show indicator
        const ALIGNMENT_THRESHOLD = 0.08; // ~4.6 degrees - much tighter for proper overlap
        
        if (nearestHotspot && nearestDistance < APPROACH_THRESHOLD) {
            this.currentHotspot = nearestHotspot;
            this.isAligned = nearestDistance < ALIGNMENT_THRESHOLD;
            
            // Update visual feedback
            if (this.scene) {
                this.scene.highlightHotspot(this.currentHotspot.id, this.isAligned);
            }
            
            // Show alignment indicator
            this.elements.alignmentIndicator.classList.add('visible');
            
            if (this.isAligned) {
                this.elements.alignmentIndicator.classList.add('aligned');
                this.elements.alignmentIndicator.classList.remove('approaching');
                
                if (!this.capturedHotspots.has(this.currentHotspot.id)) {
                    // Check if device is level
                    const isDeviceLevel = this.isDeviceLevel();
                    
                    if (!isDeviceLevel) {
                        this.elements.instructions.textContent = 'Level your device';
                        this.clearAlignmentTimer();
                    } else {
                        this.elements.instructions.textContent = 'Hold steady...';
                        
                        // Start auto-capture timer if not already started and device is level
                        if (!this.alignmentTimer && !this.isCapturing) {
                            // Add countdown visual feedback
                            let countdown = this.CAPTURE_DELAY / 1000;
                            const countdownInterval = setInterval(() => {
                                countdown--;
                                if (countdown > 0) {
                                    // Check if still level during countdown
                                    if (!this.isDeviceLevel()) {
                                        this.elements.instructions.textContent = 'Level your device';
                                        clearInterval(countdownInterval);
                                        this.clearAlignmentTimer();
                                    } else {
                                        this.elements.instructions.textContent = `Capturing in ${countdown}...`;
                                    }
                                } else {
                                    clearInterval(countdownInterval);
                                }
                            }, 1000);
                            
                            this.elements.alignmentIndicator.classList.add('holding');
                            this.alignmentTimer = setTimeout(() => {
                                clearInterval(countdownInterval);
                                this.alignmentTimer = null;
                                this.elements.alignmentIndicator.classList.remove('holding');
                                if (this.isAligned && this.currentHotspot && 
                                    this.currentHotspot.id === nearestHotspot.id &&
                                    !this.capturedHotspots.has(this.currentHotspot.id) &&
                                    this.isDeviceLevel()) {
                                    this.handleCapture();
                                }
                            }, this.CAPTURE_DELAY);
                        }
                    }
                } else {
                    this.elements.instructions.textContent = 'Already captured';
                }
            } else {
                this.elements.alignmentIndicator.classList.add('approaching');
                this.elements.alignmentIndicator.classList.remove('aligned');
                this.elements.instructions.textContent = 'Almost there...';
                
                // Update color based on proximity
                const proximity = 1 - (nearestDistance / APPROACH_THRESHOLD);
                const orange = Math.floor(165 * proximity);
                this.elements.alignmentIndicator.style.borderColor = `rgb(255, ${orange}, 0)`;
                
                // Clear timer if we lose alignment
                this.clearAlignmentTimer();
            }
        } else {
            this.currentHotspot = null;
            this.isAligned = false;
            
            // Clear timer if we move away
            this.clearAlignmentTimer();
            
            // Reset all hotspots when none are near
            if (this.scene) {
                this.scene.resetAllHotspots();
                
                // Hide markers for captured hotspots
                this.capturedHotspots.forEach(hotspotId => {
                    this.scene.markHotspotCaptured(hotspotId);
                });
            }
            
            // Hide alignment indicator when not near a hotspot
            this.elements.alignmentIndicator.classList.remove('visible', 'aligned', 'approaching');
            
            const captured = this.capturedHotspots.size;
            if (captured === 0) {
                this.elements.instructions.textContent = 'Align to start';
            } else {
                this.elements.instructions.textContent = `${captured} / ${Hotspots.TOTAL_HOTSPOTS} captured`;
            }
        }
    }

    clearAlignmentTimer() {
        this.elements.alignmentIndicator.classList.remove('holding');
        if (this.alignmentTimer) {
            clearTimeout(this.alignmentTimer);
            this.alignmentTimer = null;
        }
    }

    async handleCapture() {
        console.log('handleCapture called', { isAligned: this.isAligned, currentHotspot: this.currentHotspot });
        
        // Don't capture if start screen is visible
        const startScreen = document.getElementById('start-screen');
        if (startScreen && startScreen.style.display !== 'none') {
            console.log('Start screen is visible, capture disabled');
            return;
        }
        
        if (!this.isAligned || !this.currentHotspot || this.isCapturing) {
            console.log('Not aligned with a hotspot or already capturing');
            return;
        }
        
        if (this.capturedHotspots.has(this.currentHotspot.id)) {
            console.log('Hotspot already captured');
            return;
        }
        
        console.log('Capturing photo for hotspot', this.currentHotspot.id);
        
        this.isCapturing = true;
        this.clearAlignmentTimer();
        
        try {
            // Capture photo with reduced resolution
            let framePose;
            const imageBlob = await this.camera.capturePhoto(
                this.CAPTURE_RESOLUTION.width,
                this.CAPTURE_RESOLUTION.height,
                frame => { framePose = capturePose(this.scene.camera, frame); }
            );
            
            // Use the pose saved with the pixels, not the phone's pose after
            // asynchronous JPEG encoding completes.
            if (!framePose) throw new Error('Capture did not provide frame orientation');
            const actualYaw = framePose.yaw, actualPitch = framePose.pitch;
            
            // Track compass heading of first capture for metadata
            let compassYaw = actualYaw;
            
            // Handle iOS compass heading
            if (this.deviceOrientation.compassHeading !== undefined) {
                // iOS provides true compass heading directly
                compassYaw = this.deviceOrientation.compassHeading;
                
                if (this.capturedHotspots.size === 0) {
                    this.firstCaptureCompassHeading = compassYaw;
                    console.log(`First capture iOS compass heading: ${compassYaw.toFixed(1)}° (will be used for InitialViewHeadingDegrees)`);
                }
                console.log(`Capture ${this.capturedHotspots.size + 1}: iOS compassYaw=${compassYaw.toFixed(1)}°`);
            } 
            // Handle Android/desktop absolute orientation
            else if (this.deviceOrientation.absolute && this.compassOffset !== null) {
                // Adjust yaw to be relative to true north instead of device start position
                compassYaw = (actualYaw + this.compassOffset) % 360;
                
                if (this.capturedHotspots.size === 0) {
                    this.firstCaptureCompassHeading = compassYaw;
                    console.log(`First capture compass heading: ${compassYaw.toFixed(1)}° (will be used for InitialViewHeadingDegrees)`);
                }
                console.log(`Capture ${this.capturedHotspots.size + 1}: compassYaw=${compassYaw.toFixed(1)}° (device yaw=${actualYaw.toFixed(1)}° + offset=${this.compassOffset.toFixed(1)}°)`);
            } 
            // No compass data available
            else {
                console.log(`Capture ${this.capturedHotspots.size + 1}: No compass data available (using device-relative yaw=${actualYaw.toFixed(1)}°)`);
            }
            
            // Calculate the delta between expected and actual orientation
            // This captures how the user's actual position differs from the ideal hotspot
            const yawDelta = this.normalizeAngleDelta(actualYaw - this.currentHotspot.yaw);
            const pitchDelta = actualPitch - this.currentHotspot.pitch;
            
            // Save to database with orientation data
            const hotspotData = {
                hotspotId: this.currentHotspot.id,
                imageBlob: imageBlob,
                // Expected/ideal position
                yaw: this.currentHotspot.yaw,
                pitch: this.currentHotspot.pitch,
                // Actual captured orientation
                actualYaw: actualYaw,
                actualPitch: actualPitch,
                compassYaw: compassYaw, // Real-world compass heading
                hasCompass: this.deviceOrientation.absolute, // Track if we have absolute orientation
                // Deltas for fine-tuning placement
                yawDelta: yawDelta,
                pitchDelta: pitchDelta,
                roll: framePose.roll,
                orientationQuaternion: framePose.orientationQuaternion,
                orientationVersion: framePose.orientationVersion,
                orientationTimestamp: framePose.orientationTimestamp,
                videoTime: framePose.videoTime,
                // Field of view
                fov: Hotspots.calculateFOV(this.currentHotspot.pitch),
                timestamp: new Date(framePose.orientationTimestamp).toISOString()
            };
            
            try {
                await this.database.saveImage(hotspotData);
            } catch (error) {
                console.error('Failed to save image:', error);
                if (this.cardUI) {
                    await this.cardUI.alert(
                        `Failed to save image: ${error.message}`,
                        'Storage Error'
                    );
                }
                return;
            }
            
            // Update UI
            this.capturedHotspots.add(this.currentHotspot.id);
            if (this.scene) {
                this.scene.markHotspotCaptured(this.currentHotspot.id);
                // Create blob URL for display (will be cleaned up when scene resets)
                const blobUrl = URL.createObjectURL(imageBlob);
                this.scene.addCapturedPatch(this.currentHotspot, blobUrl);
            }
            
            // Update progress
            this.updateProgress();
            
            console.log('Photo captured successfully for hotspot', this.currentHotspot.id);
            
            // Reset capture state after a delay
            setTimeout(() => {
                this.isCapturing = false;
            }, 500);
            
        } catch (error) {
            console.error('Capture error:', error);
            if (this.cardUI) {
                await this.cardUI.alert('Failed to capture photo', 'Capture Error');
            }
            this.isCapturing = false;
        }
    }

    /**
     * Update all progress indicators after capture state changes
     * 
     * Updates:
     * - Progress ring (fills as images are captured)
     * - Checkmark color (orange -> green when complete)
     * - Instruction text ("12/37 captured")
     * - Screen reader announcements at milestones
     * 
     * Called after each successful capture or when session is cleared
     */
    updateProgress() {
        const captured = this.capturedHotspots.size;
        const total = Hotspots.TOTAL_HOTSPOTS;
        const progress = (captured / total) * 100;
        
        // Update counter
        // this.elements.progressCounter.textContent = `${captured} / ${total}`;
        
        // Update progress circle using stroke-dashoffset
        const strokeDashoffset = 100 - progress;
        this.elements.progressPath.style.strokeDashoffset = strokeDashoffset;
        const countEl = document.getElementById('capture-count');
        if (countEl) countEl.textContent = `${captured}/${total}`;
        this.elements.captureBtn.classList.toggle('is-complete', captured === total);
        this.elements.captureBtn.setAttribute('aria-label', `${captured} of ${total} photos captured. Finish capture and stitch`);
        
        // Update checkmark color and instructions based on completion
        if (captured === total) {
            // All captured - turn checkmark green
            this.elements.captureCheckmark.style.fill = '#4CAF50';
            this.elements.instructions.textContent = 'Capture complete! Ready to stitch';
            this.announceToScreenReader(`Capture complete! All ${total} images captured. Ready to stitch panorama.`);
        } else if (captured > 0) {
            // In progress - checkmark stays orange
            this.elements.captureCheckmark.style.fill = 'orange';
            this.elements.instructions.textContent = `${captured} / ${total} captured`;
            // Announce progress at key milestones
            if (captured === 1) {
                this.announceToScreenReader(`First image captured. ${captured} of ${total} complete.`);
            } else if (captured % 6 === 0 || captured === total - 1) {
                // Announce every 6 images and when nearly complete
                this.announceToScreenReader(`${captured} of ${total} images captured.`);
            }
        } else {
            // No captures yet - reset instructions
            this.elements.captureCheckmark.style.fill = 'orange';
            this.elements.instructions.textContent = 'Align with hotspots to capture';
        }
    }

    setCapturingEnabled(enabled) {
        this.isCapturing = !enabled;
        this.isCapturingEnabled = enabled;
        this.elements.captureBtn.disabled = !enabled;
    }

    async startStitching() {
        // OpenCV removed - proceeding with WebGL2 stitching
        
        this.setCapturingEnabled(false);
        // Show stitching overlay with lift in animation
        this.elements.stitchingOverlay.classList.remove('pressing-down');
        this.elements.stitchingOverlay.classList.add('lifting-in', 'visible');
        setTimeout(() => {
            this.elements.stitchingOverlay.classList.remove('lifting-in');
        }, 250);
        this.elements.progressBar.style.width = '0%';
        this.elements.statusText.textContent = 'Loading captured images...';
        this.elements.statusDetails.textContent = 'Retrieving from IndexedDB...';
        
        try {
            // Load images from database
            const capturedData = await this.database.loadCapturedImages();
            
            if (capturedData.length < 2) {
                if (this.cardUI) {
                    await this.cardUI.alert('Need at least 2 images to create a photosphere', 'Not Enough Images');
                }
                // Close with press down animation
                this.elements.stitchingOverlay.classList.remove('lifting-in');
                this.elements.stitchingOverlay.classList.add('pressing-down');
                setTimeout(() => {
                    this.elements.stitchingOverlay.classList.remove('visible', 'pressing-down');
                }, 200);
                this.setCapturingEnabled(true);
                return;
            }
            
            console.log(`Starting stitch with ${capturedData.length} images`);
            
            // Convert database objects to cv.Mat objects and metadata
            const imageMats = [];
            const imageMetadata = [];
            
            for (const capture of capturedData) {
                // Load image as Mat
                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = capture.imageData;
                });
                
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const mat = matFromImageData(imageData);
                imageMats.push(mat);
                
                // Extract metadata
                imageMetadata.push({
                    hotspotId: capture.hotspotId,
                    pitch: capture.pitch || 0,
                    yaw: capture.yaw || 0,
                    fov: capture.fov || 40
                });
            }

            const result = await this.stitcher.stitch(imageMats, imageMetadata, (progress, status) => {
                this.elements.progressBar.style.width = `${progress * 100}%`;
                this.elements.statusText.textContent = status;
            });

            if (result && !result.empty()) {
                const canvas = document.createElement('canvas');
                cv.imshow(canvas, result);
                
                // Clean up the result Mat
                result.delete();

                this.showStitchResult(canvas);
                
                // Create JPEG blob for storage
                const panoramaBlob = await new Promise(resolve => 
                    canvas.toBlob(resolve, 'image/jpeg', 0.9)
                );
                
                const panoramaData = {
                    imageBlob: panoramaBlob,
                    timestamp: new Date().toISOString(),
                    imageCount: capturedData.length,
                    type: 'equirectangular',
                    width: canvas.width,
                    height: canvas.height
                };
                
                await this.database.savePanorama(panoramaData);
                console.log('Panorama saved to database');
                
                // Mark stitch job as complete if we have one
                if (this.stitchRecovery && this.currentStitchJobId) {
                    await this.stitchRecovery.markJobCompleted(this.currentStitchJobId);
                    console.log(`Marked stitch job ${this.currentStitchJobId} as complete`);
                    this.currentStitchJobId = null; // Clear the job ID
                }
                
                this.elements.progressBar.style.width = '100%';
                this.elements.statusText.textContent = 'Photosphere Complete!';
                this.elements.statusDetails.textContent = `Successfully stitched ${capturedData.length} images`;
                
                // Announce completion to screen readers
                this.announceToScreenReader(`Panorama processing complete. Successfully stitched ${capturedData.length} images. View and share buttons are now available.`);
            } else {
                throw new Error('Stitching failed - no result returned');
            }
            
        } catch (error) {
            console.error('Stitching error:', error);
            if (this.cardUI) {
                // Sanitize error message to prevent XSS
                const safeMessage = String(error.message).replace(/[<>]/g, '');
                await this.cardUI.alert('Stitching failed: ' + safeMessage, 'Stitching Error');
            }
            this.setCapturingEnabled(true);
        }
        
        this.elements.progressBar.style.width = '100%';
        this.elements.statusText.textContent = 'Done!';
    }

    showStitchResult(canvas) {
        console.log('showStitchResult called with canvas:', canvas.width, 'x', canvas.height);
        
        // Make sure the overlay is visible
        const overlay = document.getElementById('stitching-overlay');
        if (overlay.style.display === 'none') {
            console.log('Making overlay visible');
            overlay.style.display = 'flex';
        }
        
        // Update preview
        const ctx = this.elements.previewCanvas.getContext('2d');
        console.log('Preview canvas size:', this.elements.previewCanvas.width, 'x', this.elements.previewCanvas.height);
        
        const scale = Math.min(
            this.elements.previewCanvas.width / canvas.width,
            this.elements.previewCanvas.height / canvas.height
        );
        
        const width = canvas.width * scale;
        const height = canvas.height * scale;
        const x = (this.elements.previewCanvas.width - width) / 2;
        const y = (this.elements.previewCanvas.height - height) / 2;
        
        console.log('Drawing at:', x, y, 'size:', width, 'x', height);
        
        ctx.clearRect(0, 0, this.elements.previewCanvas.width, this.elements.previewCanvas.height);
        ctx.drawImage(canvas, x, y, width, height);
        console.log('Preview updated');
        
        document.getElementById('close-stitch-overlay-btn').addEventListener('click', () => { 
            // Close with press down animation
            this.elements.stitchingOverlay.classList.remove('lifting-in');
            this.elements.stitchingOverlay.classList.add('pressing-down');
            setTimeout(() => {
                this.elements.stitchingOverlay.classList.remove('visible', 'pressing-down');
            }, 300); 
            this.setCapturingEnabled(true);
        });
        
        // Add download button
        const downloadBtn = document.getElementById('download-btn');
        if (downloadBtn) {
            downloadBtn.onclick = async () => {
                try {
                    // Convert canvas to blob
                    const blob = await new Promise(resolve => 
                        canvas.toBlob(resolve, 'image/jpeg', 0.9)
                    );
                    
                    // Generate timestamp filename
                    const now = new Date();
                    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
                    const filename = `photosphere_${timestamp}.jpg`;
                    
                    // Use share API
                    await photoSphereSharer.sharePhotosphere(blob, filename);
                } catch (error) {
                    console.error('Share failed:', error);
                }
            };
        }
        
        // Add view button for Pannellum
        const viewBtn = document.getElementById('view-btn');
        if (viewBtn) {
            viewBtn.onclick = () => {
                // Pass the first capture compass heading for proper orientation
                this.viewPanorama(canvas, this.firstCaptureCompassHeading);
            };
        }
    }

    async viewPanorama(canvas, compassHeading = null) {
        console.log(`Opening panorama viewer with compass heading: ${compassHeading !== null ? compassHeading.toFixed(1) + '°' : 'none'}`);
        
        // Convert canvas to blob URL
        canvas.toBlob((blob) => {
            const imageUrl = URL.createObjectURL(blob);
            
            // Calculate actual panorama coverage
            const expectedWidth = canvas.height * 2; // 2:1 ratio for full 360
            const horizontalCoverage = Math.min((canvas.width / expectedWidth) * 360, 360);
            const verticalCoverage = 180; // Assume full vertical coverage
            
            console.log(`Panorama coverage: ${horizontalCoverage.toFixed(1)}° horizontal`);
            
            // Create viewer container
            const viewerContainer = document.createElement('div');
            viewerContainer.id = 'panorama-viewer';
            viewerContainer.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                z-index: 2000;
                background: black;
            `;
            
            // Add close button matching card style
            const closeBtn = document.createElement('button');
            closeBtn.className = 'card-close-btn';
            closeBtn.innerHTML = '<img src="./img/x.svg" style="width: 20px; height: 20px; filter: brightness(0) invert(1);" alt="Close">';
            closeBtn.style.cssText = `
                position: absolute;
                top: max(15px, calc(15px + env(safe-area-inset-top, 0px)));
                right: max(15px, env(safe-area-inset-right, 15px));
                width: 40px;
                height: 40px;
                border-radius: 50%;
                border: 1px solid rgba(255, 255, 255, 0.3);
                background: rgba(255, 255, 255, 0.15);
                backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
                color: white;
                cursor: pointer;
                transition: all 0.3s ease;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 2001;
            `;
            
            closeBtn.onclick = () => {
                viewerContainer.remove();
                URL.revokeObjectURL(imageUrl);
            };
            
            viewerContainer.appendChild(closeBtn);
            document.body.appendChild(viewerContainer);
            
            // Configure Pannellum for partial panoramas
            const config = {
                type: 'equirectangular',
                panorama: imageUrl,
                autoLoad: true,
                // Disable auto rotation for partial panos
                autoRotate: horizontalCoverage > 300 ? -2 : 0,
                showFullscreenCtrl: true,
                mouseZoom: true,
                keyboardZoom: true,
                showZoomCtrl: true,
                showControls: true,
                // Field of view settings
                hfov: Math.min(horizontalCoverage * 0.8, 100), // Start zoomed appropriately
                minHfov: 30,
                maxHfov: 120,
                // No pitch/yaw limits
                minPitch: -90,
                maxPitch: 90,
                // For partial panoramas, limit the yaw range
                minYaw: horizontalCoverage < 360 ? -(horizontalCoverage / 2) : -180,
                maxYaw: horizontalCoverage < 360 ? (horizontalCoverage / 2) : 180,
                // Orient the view based on compass heading
                // If we have a compass heading, use it to set the initial view
                // The yaw in Pannellum is relative to the image center, not compass north
                // So we need to use northOffset to align the panorama with real-world directions
                pitch: 0,
                yaw: 0, // Start looking at the same direction as first capture
                // UI settings
                compass: horizontalCoverage > 300 && compassHeading !== null,
                // northOffset tells Pannellum how to align the compass
                // It's the angle from image center to north
                // If first capture was facing north (0°), northOffset should be 0
                // If first capture was facing east (90°), northOffset should be -90
                northOffset: compassHeading !== null ? -compassHeading : 0,
                // Background for missing areas
                backgroundColor: [0, 0, 0],
                // Performance
                disableKeyboardCtrl: false,
                friction: 0.15,
                // For partial panoramas, don't wrap around
                haov: horizontalCoverage,
                vaov: verticalCoverage,
                // Tell Pannellum this is a partial panorama
                ignoreGPanoXMP: true
            };
            
            // Add info overlay for partial panoramas
            if (horizontalCoverage < 360) {
                const infoOverlay = document.createElement('div');
                infoOverlay.style.cssText = `
                    position: absolute;
                    bottom: 20px;
                    left: 20px;
                    background: rgba(0,0,0,0.7);
                    color: white;
                    padding: 10px 15px;
                    border-radius: 5px;
                    font-size: 14px;
                `;
                infoOverlay.textContent = `Partial panorama: ${horizontalCoverage.toFixed(0)}° coverage`;
                viewerContainer.appendChild(infoOverlay);
            }
            
            // Initialize Pannellum
            pannellum.viewer('panorama-viewer', config);
            
            console.log('Pannellum initialized with config:', config);
        }, 'image/jpeg', 0.9);
    }

    /**
     * Reset capture and return to start screen
     * Called from the "Start New Capture" button in stitching overlay
     * 
     * @async
     */
    async resetAndStartNewCapture() {
        // Close the stitching overlay
        if (this.elements.stitchingOverlay) {
            this.elements.stitchingOverlay.classList.remove('lifting-in');
            this.elements.stitchingOverlay.classList.add('pressing-down');
            setTimeout(() => {
                this.elements.stitchingOverlay.classList.remove('visible', 'pressing-down');
            }, 300);
        }
        
        // Clear the session (the stitched frames stay for the gallery export)
        await this.clearSession(true);
        
        // Show start screen with visible class for proper animation
        const startScreen = document.getElementById('start-screen');
        if (startScreen) {
            startScreen.style.display = 'block';
            startScreen.classList.add('visible');
        }
        
        // Hide capture UI
        document.getElementById('scene-container').style.display = 'none';
        document.getElementById('camera-viewport').style.display = 'none';
        document.getElementById('alignment-indicator').style.display = 'none';
        document.getElementById('instructions').style.display = 'none';
        const bottomControls = document.querySelector('.bottom-controls');
        if (bottomControls) {
            bottomControls.style.display = 'none';
        }
        
        // Hide grid background
        const gridBackground = document.getElementById('grid-background');
        if (gridBackground) {
            gridBackground.style.display = 'none';
            gridBackground.classList.remove('visible');
        }
    }

    /**
     * Clear all captured images and reset to initial state
     * 
     * This method:
     * - Deletes all images from IndexedDB
     * - Clears the 3D visualization
     * - Resets progress indicators
     * - Returns to start screen
     * 
     * Called when user taps the reset button
     * 
     * @async
     */
    /**
     * Start stitching with specific data (used for recovery)
     */
    async startBestPixelStitchingWithData(capturedData, jobId = null) {
        // Set the job ID if provided (for recovery)
        if (jobId) {
            this.currentStitchJobId = jobId;
        }
        
        // Show stitching overlay
        this.elements.stitchingOverlay.classList.remove('pressing-down');
        this.elements.stitchingOverlay.classList.add('lifting-in', 'visible');
        this.elements.stitchingOverlay.removeAttribute('aria-hidden');
        setTimeout(() => {
            this.elements.stitchingOverlay.classList.remove('lifting-in');
        }, 250);
        
        this.elements.progressBar.style.width = '0%';
        this.elements.statusText.textContent = 'Resuming stitch...';
        this.elements.statusDetails.textContent = `Processing ${capturedData.length} images...`;
        
        // Lock the processing card UI
        this.lockProcessingCard();
        
        // Hide capture UI
        document.getElementById('scene-container').style.display = 'none';
        document.getElementById('camera-viewport').style.display = 'none';
        document.getElementById('alignment-indicator').style.display = 'none';
        document.getElementById('instructions').style.display = 'none';
        const bottomControls = document.querySelector('.bottom-controls');
        if (bottomControls) {
            bottomControls.style.display = 'none';
        }
        
        // Perform the stitching
        await this.performBestPixelStitching(capturedData);
    }
    
    // keepImages: after a stitch the frames stay in IndexedDB until the next
    // capture starts, so the gallery can export them for a desktop repro.
    async clearSession(keepImages = false) {
        if (!keepImages) await this.database.clearAllImages();
        this.capturedHotspots.clear();
        if (this.scene) {
            this.scene.clearCapturedPatches();
            this.scene.resetAllHotspots();
        }
        
        // Reset compass tracking for new session
        this.compassOffset = null;
        this.firstCaptureCompassHeading = null;
        
        // Reset progress circle and checkmark if UI is ready
        if (this.elements) {
            if (this.elements.progressPath) {
                this.elements.progressPath.style.strokeDashoffset = '100';
            }
            if (this.elements.captureCheckmark) {
                this.elements.captureCheckmark.style.fill = 'orange';
            }
        }
        
        this.updateProgress();
        console.log('Cleared previous capture session');
        
        // Stop camera and disable capturing
        if (this.camera) {
            this.camera.stop();
        }
        this.setCapturingEnabled(false);
        
        // Hide capture UI elements
        if (this.scene) {
            this.scene.showStartScreenState();
        }
        
        // Hide all capture UI elements
        const sceneContainer = document.getElementById('scene-container');
        const cameraViewport = document.getElementById('camera-viewport');
        const alignmentIndicator = document.getElementById('alignment-indicator');
        const instructions = document.getElementById('instructions');
        const bottomControls = document.querySelector('.bottom-controls');
        const gridBackground = document.getElementById('grid-background');
        
        if (sceneContainer) sceneContainer.style.display = 'none';
        if (cameraViewport) cameraViewport.style.display = 'none';
        if (alignmentIndicator) alignmentIndicator.style.display = 'none';
        if (instructions) instructions.style.display = 'none';
        if (bottomControls) bottomControls.style.display = 'none';
        if (gridBackground) {
            gridBackground.style.display = 'none';
            gridBackground.classList.remove('visible');
        }
        
        // Show start screen with proper animation
        const startScreen = document.getElementById('start-screen');
        if (startScreen) {
            startScreen.style.display = 'block';
            // Force reflow to ensure display change is applied
            startScreen.offsetHeight;
            // Add visible class for animation
            startScreen.classList.add('visible');
            startScreen.classList.remove('pressing-down');
        }
    }
    
    /**
     * Reset capture session and return to start screen
     * Used when leaving capture mode for camera roll
     */
    async resetCapture() {
        // Clear session already handles returning to start screen
        await this.clearSession();
    }

    // Alias for re-stitching from adjustments
    async restitch() {
        console.log('Re-stitching with current adjustments...');

        // Hide the result card to show progress
        if (this.cardUI) {
            this.cardUI.hideCard('result-card');
            this.cardUI.hideCard('adjustments-card');
        }

        // Clear any cached panorama
        const resultImg = document.getElementById('result-image');
        if (resultImg) {
            resultImg.src = '';
        }

        // Force reload of FOV settings from localStorage
        // These are set by the adjustment sliders
        const hOffset = parseFloat(localStorage.getItem('fov-h-offset') || '0');
        const vOffset = parseFloat(localStorage.getItem('fov-v-offset') || '0');
        console.log(`Using FOV adjustments: H=${hOffset}°, V=${vOffset}°`);

        return this.stitchExisting();
    }

    async stitchExisting() {
        // Check for existing images in database
        const existingImages = await this.database.loadCapturedImages();

        if (existingImages.length === 0) {
            if (this.cardUI) {
                await this.cardUI.alert('No existing images found in database.', 'No Images');
            }
            return;
        }
        
        // Hide start screen
        const startScreen = document.getElementById('start-screen');
        if (startScreen) {
            startScreen.style.display = 'none';
        }
        
        // Load existing images into the app state
        console.log(`Found ${existingImages.length} existing images, loading...`);
        
        // Update captured hotspots set and UI
        existingImages.forEach(data => {
            this.capturedHotspots.add(data.hotspotId);
            const hotspot = this.hotspots.find(h => h.id === data.hotspotId);
            if (hotspot && this.scene) {
                this.scene.markHotspotCaptured(data.hotspotId);
                this.scene.addCapturedPatch(hotspot, data.imageData);
            }
        });
        
        // Update progress display
        this.updateProgress();
        
        // Show capture UI elements
        if (this.scene) {
            this.scene.showCaptureState();
        }
        
        // Enable capturing and start camera
        this.setCapturingEnabled(true);
        await this.camera.startCamera();
        
        // Show the capture UI with existing images loaded
        console.log(`Loaded ${existingImages.length} existing images. Ready to stitch!`);
    }

    async startBestPixelStitching() {
        this.setCapturingEnabled(false);
        
        // Announce to screen readers
        this.announceToScreenReader('Starting panorama processing. Please wait.');
        
        // Hide capture UI elements when showing processor card
        document.getElementById('scene-container').style.display = 'none';
        document.getElementById('camera-viewport').style.display = 'none';
        document.getElementById('alignment-indicator').style.display = 'none';
        document.getElementById('instructions').style.display = 'none';
        const bottomControls = document.querySelector('.bottom-controls');
        if (bottomControls) {
            bottomControls.style.display = 'none';
        }
        
        // Show stitching overlay with lift in animation
        this.elements.stitchingOverlay.classList.remove('pressing-down');
        this.elements.stitchingOverlay.classList.add('lifting-in', 'visible');
        this.elements.stitchingOverlay.removeAttribute('aria-hidden');
        setTimeout(() => {
            this.elements.stitchingOverlay.classList.remove('lifting-in');
        }, 250);
        this.elements.progressBar.style.width = '0%';
        this.elements.statusText.textContent = 'Loading captured images...';
        this.elements.statusDetails.textContent = 'Retrieving from IndexedDB...';
        
        // Lock the processing card UI
        this.lockProcessingCard();
        
        try {
            // Load captured images
            const capturedData = await this.database.loadCapturedImages();
            
            if (capturedData.length === 0) {
                throw new Error('No captured images found');
            }
            
            // Create stitch job for recovery tracking
            if (this.stitchRecovery) {
                const imageIds = capturedData.map(img => String(img.hotspotId));
                const params = {
                    method: 'best-pixel',
                    imageCount: capturedData.length,
                    timestamp: new Date().toISOString()
                };
                this.currentStitchJobId = await this.stitchRecovery.createStitchJob(imageIds, params);
                console.log(`Created stitch job: ${this.currentStitchJobId}`);
            }
            
            // Continue with stitching
            await this.performBestPixelStitching(capturedData);
            
        } catch (error) {
            console.error('Stitching failed:', error);
            
            // Mark job as failed if we have one
            if (this.stitchRecovery && this.currentStitchJobId) {
                await this.stitchRecovery.markJobFailed(this.currentStitchJobId, error);
            }
            
            // Show error to user
            this.elements.stitchingOverlay.classList.add('is-failed');
            this.elements.statusText.textContent = 'Stitching Failed';
            this.elements.statusDetails.textContent = error.message;
            this.unlockProcessingCard();
            
            if (this.cardUI) {
                await this.cardUI.alert(
                    `Failed to create panorama: ${error.message}`,
                    'Stitching Error'
                );
            }
        }
    }
    
    /**
     * Perform the actual stitching (separated for recovery)
     */
    async performBestPixelStitching(capturedData) {
        this._zenithDiagnostics = [];
        try {
            if (!capturedData || capturedData.length === 0) {
                throw new Error('No captured images found');
            }
            // New captures retain the complete rotation. Older sessions keep
            // their original pose and can use image-based zenith recovery.
            capturedData = capturedData.map(c => {
                const pose = poseFromQuaternion(c.orientationQuaternion);
                return pose ? { ...c, actualYaw: pose.yaw, actualPitch: pose.pitch, roll: pose.roll } : c;
            });
            
            console.log(`Starting best-pixel stitch with ${capturedData.length} images`);
            this.elements.statusDetails.textContent = `Processing ${capturedData.length} images...`;
            
            // Mark job as started if we have one
            if (this.stitchRecovery && this.currentStitchJobId) {
                await this.stitchRecovery.markJobStarted(this.currentStitchJobId);
            }
            
            // Set up progress callbacks for the stitch processor
            this.stitchProcessor.onProgress = (percent, message) => {
                // First 50% is for image processing
                const progress = percent * 0.5;
                this.elements.progressBar.style.width = `${progress}%`;
                if (message) {
                    this.elements.statusDetails.textContent = message;
                }
            };
            
            this.stitchProcessor.onStatus = (status) => {
                this.elements.statusText.textContent = status;
            };
            
            // Process images using worker (or fallback to main thread)
            this.elements.statusText.textContent = 'Processing images...';
            const layers = await this.stitchProcessor.process(capturedData);
            
            console.log(`Received ${layers.length} processed layers from worker`);
            
            // Update status for WebGL rendering
            this.elements.statusText.textContent = 'Rendering sharp panorama...';
            this.elements.statusDetails.textContent = 'Using best-pixel selection...';
            this.elements.progressBar.style.width = '50%';
            
            // Create equirectangular canvas for WebGL rendering
            const erpCanvas = document.createElement('canvas');
            erpCanvas.width = 4096;
            erpCanvas.height = 2048;
            
            // Initialize WebGL2 for best-pixel selection
            const gl = erpCanvas.getContext('webgl2', {
                premultipliedAlpha: false,
                preserveDrawingBuffer: true,
                failIfMajorPerformanceCaveat: false // Don't fail on software rendering
            });
            
            if (!gl) {
                throw new Error('WebGL2 not supported.');
            }
            
            // Handle context loss
            let contextLost = false;
            let gpuReleased = false;
            erpCanvas.addEventListener('webglcontextlost', (e) => {
                if (gpuReleased) return;
                e.preventDefault();
                contextLost = true;
                console.error('WebGL context lost during stitching');
                this.elements.statusDetails.textContent = 'GPU error - retrying...';
            }, false);
            
            erpCanvas.addEventListener('webglcontextrestored', () => {
                contextLost = false;
                console.log('WebGL context restored');
            }, false);
            
            // Use simple lightweight aligner
            let seamAlignments = [];
            try {
                const { SimpleAligner } = await import('./simple-aligner.js');
                const aligner = new SimpleAligner();

                this.elements.statusText.textContent = 'Quick alignment...';
                this.elements.statusDetails.textContent = 'Using roll data for vertical correction...';

                // Calculate alignments quickly for equator only
                seamAlignments = await aligner.calculateAlignments(layers);
                console.log('Quick alignments done:', seamAlignments.length, 'seams');

                // Log summary
                if (seamAlignments.length > 0) {
                    const rollComps = seamAlignments.filter(a => a.rollCompensation !== undefined);
                    if (rollComps.length > 0) {
                        const avgRoll = rollComps.reduce((sum, a) => sum + Math.abs(a.rollCompensation), 0) / rollComps.length;
                        const maxRoll = Math.max(...rollComps.map(a => Math.abs(a.rollCompensation)));
                        console.log(`🔄 Average roll compensation: ${avgRoll.toFixed(2)}°`);
                        console.log(`🎯 Max roll compensation: ${maxRoll.toFixed(2)}°`);
                    }
                }
            } catch (e) {
                console.warn('Simple alignment failed, continuing without it:', e);
            }

            // Convert layers from worker (with bitmaps/canvases) to WebGL-ready format
            // The worker returns layers with either bitmap or canvas properties
            const webglLayers = [];
            for (const layer of layers) {
                if (layer.bitmap) {
                    // Convert ImageBitmap to canvas for WebGL
                    const canvas = document.createElement('canvas');
                    canvas.width = layer.width || this.CAPTURE_RESOLUTION.width;
                    canvas.height = layer.height || this.CAPTURE_RESOLUTION.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(layer.bitmap, 0, 0);
                    layer.bitmap.close(); // Clean up bitmap
                    
                    webglLayers.push({
                        name: `hotspot_${layer.hotspotId}`,
                        hotspotId: layer.hotspotId,  // Include hotspotId for gain compensation
                        yaw: layer.yaw,
                        pitch: layer.pitch,
                        roll: layer.roll,
                        canvas: canvas
                    });
                } else if (layer.canvas) {
                    // Already have a canvas from main thread fallback
                    webglLayers.push({
                        name: `hotspot_${layer.hotspotId}`,
                        hotspotId: layer.hotspotId,  // Include hotspotId for gain compensation
                        yaw: layer.yaw,
                        pitch: layer.pitch,
                        roll: layer.roll,
                        canvas: layer.canvas
                    });
                }
            }
            
            // Sort layers for consistent ordering
            webglLayers.sort((a, b) => (b.pitch - a.pitch) || (a.yaw - b.yaw));
            for (const layer of webglLayers) {
                const capture = capturedData.find(c => c.hotspotId === layer.hotspotId);
                layer.hasFullOrientation = !!poseFromQuaternion(capture?.orientationQuaternion);
            }
            
            console.log(`Rendering best-pixel panorama with ${webglLayers.length} valid images...`);
            // Estimate FOV from overlap regions
            this.elements.statusDetails.textContent = 'Calibrating camera FOV from overlap regions...';

            const capturesMap = new Map();
            webglLayers.forEach(layer => {
                capturesMap.set(layer.hotspotId, {
                    imageData: layer.canvas,
                    yaw: layer.yaw,
                    pitch: layer.pitch,
                    actualYaw: layer.yaw,
                    actualPitch: layer.pitch,
                    roll: layer.roll || 0,
                    height: layer.canvas.height,
                    width: layer.canvas.width
                });
            });

            // FOV configuration - check multiple sources in priority order
            // 1. User fine-tuning from settings (localStorage offsets)
            // 2. Manual override for testing (sessionStorage)
            // 3. Auto-calibration (if enabled)
            // 4. Defaults: 44.7° H, 72.3° V

            // Get capture mode (indoor/outdoor)
            const captureMode = localStorage.getItem('captureMode') || 'outdoor';

            // Set base FOV based on mode
            let BASE_H_FOV, BASE_V_FOV;
            if (captureMode === 'indoor') {
                BASE_H_FOV = 43.2;
                // Calculate vertical FOV for indoor mode (9:16 portrait)
                BASE_V_FOV = 2 * Math.atan(Math.tan(43.2 * Math.PI / 360) * (16/9)) * 180 / Math.PI;
                console.log(`Indoor mode: H=${BASE_H_FOV}°, V=${BASE_V_FOV.toFixed(1)}°`);
            } else {
                BASE_H_FOV = 45.7;
                BASE_V_FOV = 73.3;
                console.log(`Outdoor mode: H=${BASE_H_FOV}°, V=${BASE_V_FOV}°`);
            }

            let estimatedFOV = null;

            // Check for user fine-tuning offsets from settings
            const hOffset = parseFloat(localStorage.getItem('fov-h-offset') || '0');
            const vOffset = parseFloat(localStorage.getItem('fov-v-offset') || '0');

            // Check for manual override (testing)
            const fovOverride = sessionStorage.getItem('overrideFOV');
            const vfovOverride = sessionStorage.getItem('overrideVFOV');
            const skipCalibration = sessionStorage.getItem('skipCalibration') === 'true';

            if (fovOverride) {
                // Manual override for testing
                const overrideH = parseFloat(fovOverride);
                let overrideV;

                if (vfovOverride) {
                    overrideV = parseFloat(vfovOverride);
                } else {
                    // Auto-calculate vertical from horizontal
                    const aspectRatio = 16 / 9;
                    overrideV = 2 * Math.atan(Math.tan(overrideH * Math.PI / 360) * aspectRatio) * 180 / Math.PI;
                }

                console.log(`Using manual override: H=${overrideH}° V=${overrideV.toFixed(1)}°`);
                estimatedFOV = {
                    horizontal: overrideH,
                    vertical: overrideV
                };
            } else if (hOffset !== 0 || vOffset !== 0) {
                // User has fine-tuned FOV in settings
                const adjustedH = BASE_H_FOV + hOffset;
                const adjustedV = BASE_V_FOV + vOffset;

                console.log(`Using fine-tuned FOV: H=${adjustedH}° V=${adjustedV}° (offsets: H${hOffset >= 0 ? '+' : ''}${hOffset}, V${vOffset >= 0 ? '+' : ''}${vOffset})`);
                estimatedFOV = {
                    horizontal: adjustedH,
                    vertical: adjustedV
                };
            } else if (!skipCalibration) {
                // Run calibration by default unless explicitly skipped
                this.elements.statusDetails.textContent = 'Calibrating camera FOV from captured images...';

                // Calibrate FOV using actual image alignment (reuse capturesMap from above)
                // Test finer increments for better precision
                const testFOVs = [41, 41.5, 42, 42.5, 43, 43.5, 44, 44.5, 45, 45.5, 46];
                estimatedFOV = await FovCalibrator.calibrateFromCaptures(capturesMap, {
                    testFOVs: testFOVs,
                    expectedFOV: 43,  // Slightly lower prior based on ghosting
                    debug: sessionStorage.getItem('debug') === 'true'
                });

                if (estimatedFOV) {
                    console.log(`Calibrated FOV: H=${estimatedFOV.horizontal}° V=${estimatedFOV.vertical.toFixed(1)}° (confidence: ${estimatedFOV.confidence.toFixed(3)})`);
                } else {
                    console.warn('FOV calibration failed, using defaults');
                }
            }
            // If no calibration or override, will default to 44°/73° in shader

            if (estimatedFOV) {
                console.log(`Using calibrated FOV: H=${estimatedFOV.horizontal.toFixed(1)}° V=${estimatedFOV.vertical.toFixed(1)}°`);
            }

            this.elements.statusDetails.textContent = `Combining ${webglLayers.length} images using best-pixel selection...`;

            await this.renderBestPixelPanorama(gl, erpCanvas, webglLayers, estimatedFOV, seamAlignments);
            
            // Apply multi-band blending for smoother seams
            // DISABLED - Current implementation reduces contrast too much
            const skipMultiband = true;
            if (!skipMultiband) {
            try {
                const blendedCanvas = await this.applyMultiBandBlending(gl, erpCanvas, webglLayers);
                if (blendedCanvas && blendedCanvas !== erpCanvas) {
                    // The blended canvas is a 2D canvas with the result already drawn
                    // We need to copy it back to the WebGL canvas (erpCanvas)
                    console.log('Copying multi-band result back to WebGL canvas');
                    
                    // Create texture from the 2D canvas
                    const texture = gl.createTexture();
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, blendedCanvas);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    
                    // Simple copy shader to draw texture to erpCanvas
                    const copyVs = `#version 300 es
                    layout(location=0) in vec2 pos;
                    out vec2 v_uv;
                    void main() { v_uv = 0.5 * pos + 0.5; gl_Position = vec4(pos, 0, 1); }`;
                    
                    const copyFs = `#version 300 es
                    precision highp float;
                    in vec2 v_uv;
                    out vec4 frag;
                    uniform sampler2D tex;
                    void main() { 
                        frag = texture(tex, vec2(v_uv.x, 1.0 - v_uv.y));
                    }`; // Flip Y for correct orientation
                    
                    const copyProg = this.compileProgram(gl, copyVs, copyFs);
                    if (copyProg) {
                        gl.useProgram(copyProg);
                        
                        // Set texture
                        gl.activeTexture(gl.TEXTURE0);
                        gl.bindTexture(gl.TEXTURE_2D, texture);
                        gl.uniform1i(gl.getUniformLocation(copyProg, 'tex'), 0);
                        
                        // Create and bind VAO/VBO
                        const vao = gl.createVertexArray();
                        gl.bindVertexArray(vao);
                        const vbo = gl.createBuffer();
                        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
                        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
                        gl.enableVertexAttribArray(0);
                        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
                        
                        // Clear and draw to default framebuffer
                        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                        gl.viewport(0, 0, erpCanvas.width, erpCanvas.height);
                        gl.clearColor(0, 0, 0, 1);
                        gl.clear(gl.COLOR_BUFFER_BIT);
                        gl.drawArrays(gl.TRIANGLES, 0, 3);
                        
                        // Cleanup
                        gl.deleteProgram(copyProg);
                        gl.deleteBuffer(vbo);
                        gl.deleteVertexArray(vao);
                    } else {
                        console.error('Failed to compile copy shader for multi-band result');
                    }
                    
                    gl.deleteTexture(texture);
                }
            } catch (e) {
                console.warn('Multi-band blending failed:', e);
                // Continue with the existing result in erpCanvas
            }
            }
            
            // Force cleanup of layer canvases before pole fill to free memory
            webglLayers.forEach(layer => {
                if (layer.canvas) {
                    layer.canvas.width = 0;
                    layer.canvas.height = 0;
                    delete layer.canvas;
                }
            });
            
            // Force garbage collection if available (non-standard but helps if supported)
            if (window.gc) {
                window.gc();
            }
            
            // Small delay to allow memory cleanup
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Apply pole filling to remove black circles at top and bottom
            try {
                fillPolesSimple(gl, erpCanvas, { nadirDeg: localStorage.getItem('tripodMode') ? 22 : 0 });
                console.log('Pole filling applied successfully');
            } catch (poleFillError) {
                console.error('Pole filling failed, continuing without it:', poleFillError);
                // Continue without pole filling if it fails
            }
            
            // Optional post-stitch exposure equalization. A single per-frame gain
            // can't fully match overlapping frames, so flat regions (open sky)
            // keep faint frame-to-frame brightness banding. This is a gentle,
            // clamped homomorphic flatten that evens low-frequency brightness while
            // preserving high-frequency detail. Off unless a strength is set, so
            // production behavior is unchanged until we deliberately enable it.
            // Default OFF: the sky reference (applySkyReference) replaces it, and
            // the two fight at broad scales. Set sessionStorage 'postEqStrength'
            // (e.g. '0.5') to re-enable for comparison.
            let equalizedCanvas = null;
            const postEqStrength = parseFloat(sessionStorage.getItem('postEqStrength') || '0');
            if (postEqStrength > 0) {
                try {
                    equalizedCanvas = await this.postExposureEqualizeERP(erpCanvas, {
                        strength: Math.min(postEqStrength, 1),
                        kernelPx: 512,
                        minGain: 0.6,
                        maxGain: 1.6,
                    });
                    console.log(`Post-exposure equalize applied (strength ${postEqStrength})`);
                } catch (e) {
                    console.warn('Post-exposure equalize failed, using raw render:', e);
                    equalizedCanvas = null;
                }
            }

            // CRITICAL: Extract the result from WebGL canvas to a 2D canvas
            // WebGL canvas can't be directly used with drawImage or toBlob reliably
            const finalCanvas = document.createElement('canvas');
            finalCanvas.width = erpCanvas.width;
            finalCanvas.height = erpCanvas.height;
            const finalCtx = finalCanvas.getContext('2d');

            if (equalizedCanvas) {
                // The equalize pass returns a WebGL canvas that is bottom-up like
                // erpCanvas, so apply the same Y-flip the readPixels path does.
                finalCtx.save();
                finalCtx.translate(0, finalCanvas.height);
                finalCtx.scale(1, -1);
                finalCtx.drawImage(equalizedCanvas, 0, 0);
                finalCtx.restore();
            } else {
            // Ensure we're reading from the default framebuffer and flush operations
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.flush();
            gl.finish(); // Force all commands to complete

            // Add a small delay to ensure rendering is complete
            await new Promise(resolve => setTimeout(resolve, 10));

            // Read pixels from WebGL canvas
            const pixels = new Uint8Array(erpCanvas.width * erpCanvas.height * 4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null); // Make absolutely sure
            gl.readPixels(0, 0, erpCanvas.width, erpCanvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);



            // Create a new Uint8ClampedArray for the ImageData (avoids readonly issues)
            const flippedPixels = new Uint8ClampedArray(erpCanvas.width * erpCanvas.height * 4);

            // Flip Y-axis (WebGL has opposite Y orientation)
            for (let y = 0; y < erpCanvas.height; y++) {
                for (let x = 0; x < erpCanvas.width; x++) {
                    const srcIdx = (y * erpCanvas.width + x) * 4;
                    const dstIdx = ((erpCanvas.height - 1 - y) * erpCanvas.width + x) * 4;
                    flippedPixels[dstIdx] = pixels[srcIdx];
                    flippedPixels[dstIdx + 1] = pixels[srcIdx + 1];
                    flippedPixels[dstIdx + 2] = pixels[srcIdx + 2];
                    flippedPixels[dstIdx + 3] = pixels[srcIdx + 3];
                }
            }

            // Create ImageData with the flipped pixels
            const imageData = new ImageData(flippedPixels, erpCanvas.width, erpCanvas.height);
            finalCtx.putImageData(imageData, 0, 0);
            }

            // Free the 4096x2048 GPU canvases now instead of whenever garbage collection runs
            gpuReleased = true;
            gl.getExtension('WEBGL_lose_context')?.loseContext();
            erpCanvas.width = erpCanvas.height = 1;
            if (equalizedCanvas) {
                equalizedCanvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
                equalizedCanvas.width = equalizedCanvas.height = 1;
                equalizedCanvas = null;
            }

            // Smooth frame-to-frame sky banding toward the soft reference.
            if (this._skyReference) {
                const skyStrength = Math.min(1, parseFloat(sessionStorage.getItem('skyRefStrength') ?? '1'));
                try {
                    const t0 = performance.now();
                    this.applySkyReference(finalCanvas, this._skyReference, skyStrength);
                    console.log(`Sky reference applied (strength ${skyStrength}) in ${(performance.now() - t0).toFixed(0)} ms`);
                    this._stitchLog?.push(`sky ref ${skyStrength} in ${(performance.now() - t0).toFixed(0)} ms`);
                } catch (e) {
                    console.warn('Sky reference failed, keeping the stitched panorama:', e);
                }
                this._skyReference = null;
            }
            
            // Progress is at 50% after stitching completes
            this.elements.progressBar.style.width = '50%';
            
            // Store the FINAL 2D canvas for view/download buttons
            this.lastStitchedPanorama = finalCanvas;
            
            // Start pixelated transition from thumbnail to final panorama
            this.elements.statusText.textContent = 'Rendering panorama...';
            this.elements.statusDetails.textContent = 'Finalizing high-resolution output...';
            
            // Get thumbnail path from canvas attribute
            const thumbnailPath = this.elements.previewCanvas.getAttribute('data-thumbnail') || './img/360_blank_thumbnail.jpg';
            
            // Create a scaled version of the stitched panorama for the preview canvas
            const scaledCanvas = document.createElement('canvas');
            scaledCanvas.width = this.elements.previewCanvas.width;
            scaledCanvas.height = this.elements.previewCanvas.height;
            const scaledCtx = scaledCanvas.getContext('2d');
            
            // Calculate scaling to fit preview canvas (use finalCanvas dimensions)
            const scale = Math.min(
                this.elements.previewCanvas.width / finalCanvas.width,
                this.elements.previewCanvas.height / finalCanvas.height
            );
            const width = finalCanvas.width * scale;
            const height = finalCanvas.height * scale;
            const x = (this.elements.previewCanvas.width - width) / 2;
            const y = (this.elements.previewCanvas.height - height) / 2;
            
            // Draw scaled panorama to temporary canvas (use finalCanvas)
            scaledCtx.fillStyle = '#000';
            scaledCtx.fillRect(0, 0, scaledCanvas.width, scaledCanvas.height);
            scaledCtx.drawImage(finalCanvas, x, y, width, height);
            
            // Create and start pixelated transition
            const transition = new PixelatedTransition(
                this.elements.previewCanvas,
                thumbnailPath,
                scaledCanvas,
                1000, // 1 second
                16 // 16x16 pixel blocks
            );
            
            // Update progress bar during transition
            transition.setProgressCallback((progress) => {
                // Transition runs from 50% to 100% of total progress
                const totalProgress = 50 + (progress * 50);
                this.elements.progressBar.style.width = `${totalProgress}%`;
                
                if (progress >= 1) {
                    this.elements.statusText.textContent = 'Panorama complete!';
                    this.elements.statusDetails.textContent = `Successfully stitched ${layers.length} images`;
                }
            });
            
            // Make preview canvas visible and start transition
            this.elements.previewCanvas.style.display = 'block';
            await transition.start();
            
            // Gather metadata for the panorama
            const timestamps = capturedData.map(d => new Date(d.timestamp || Date.now()));
            const firstPhotoDate = timestamps.reduce((min, d) => d < min ? d : min);
            const lastPhotoDate = timestamps.reduce((max, d) => d > max ? d : max);
            
            // Get first captured image heading (yaw) - based on earliest timestamp
            const sortedByTime = [...capturedData].sort((a, b) => 
                new Date(a.timestamp || 0) - new Date(b.timestamp || 0)
            );
            const firstImage = sortedByTime[0];
            // Use compass-aligned yaw if available for initial view heading
            const firstImageYaw = firstImage ? (firstImage.compassYaw || firstImage.actualYaw || firstImage.yaw) : 0;
            const hasCompassData = firstImage && firstImage.hasCompass;
            
            if (hasCompassData) {
                console.log(`Using compass-aligned panorama: InitialViewHeadingDegrees=${firstImageYaw.toFixed(1)}°`);
            } else {
                console.log('No compass data available - using device-relative orientation');
            }
            
            // Prepare metadata
            const metadata = {
                width: finalCanvas.width,
                height: finalCanvas.height,
                captureDate: new Date(),
                firstPhotoDate: firstPhotoDate,
                lastPhotoDate: lastPhotoDate,
                sourcePhotosCount: capturedData.length,
                // What this device computed, so an exported panorama can be compared with the desktop repro.
                stitchLog: [document.getElementById('app-version')?.textContent || '', navigator.userAgent.match(/(iPhone|iPad|Android|CrOS|Macintosh|Windows)[^;)]*/)?.[0] || '', ...(this._stitchLog || [])].filter(Boolean).join(' | '),
                // Use compass heading if available, this aligns the panorama to real-world directions
                // When viewing the panorama, looking at this heading will show what was actually
                // in that compass direction when captured
                initialHeading: hasCompassData ? firstImageYaw : 0,
                poseHeading: hasCompassData ? firstImageYaw : 0,
                hasCompass: hasCompassData,
                // GPS location if available
                latitude: this.captureLocation?.latitude,
                longitude: this.captureLocation?.longitude,
                altitude: this.captureLocation?.altitude
            };
            
            // Create JPEG blob with metadata
            let panoramaBlob;
            
            try {
                // First create a plain blob
                const plainBlob = await new Promise(resolve => 
                    finalCanvas.toBlob(resolve, 'image/jpeg', 0.9)
                );
                
                // Then add metadata to it
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(plainBlob);
                });
                
                panoramaBlob = await metadataUtils.addMetadataToJPEG(dataUrl, metadata);
                console.log('Successfully added metadata to panorama');
            } catch (metadataError) {
                console.error('Error adding metadata:', metadataError);
                // Fall back to simple blob without metadata
                panoramaBlob = await new Promise(resolve => 
                    finalCanvas.toBlob(resolve, 'image/jpeg', 0.9)
                );
            }
            
            // Save panorama blob to database for camera roll
            const panoramaData = {
                imageBlob: panoramaBlob,
                thumbUrl: await panoramaThumb(finalCanvas).catch(() => null),
                timestamp: new Date().toISOString(),
                imageCount: capturedData.length,
                type: 'best-pixel',
                width: finalCanvas.width,
                height: finalCanvas.height,
                hasMetadata: true,
                metadata: metadata // Store metadata separately for later use
            };
            
            try {
                await this.database.savePanorama(panoramaData);
                console.log('Panorama saved to database');
                
                // Mark stitch job as complete if we have one
                if (this.stitchRecovery && this.currentStitchJobId) {
                    await this.stitchRecovery.markJobCompleted(this.currentStitchJobId);
                    console.log(`Marked stitch job ${this.currentStitchJobId} as complete`);
                    this.currentStitchJobId = null; // Clear the job ID
                }
            } catch (error) {
                console.error('Failed to save panorama:', error);
                if (this.cardUI) {
                    await this.cardUI.alert(
                        `Failed to save panorama: ${error.message}`,
                        'Storage Error'
                    );
                }
                throw error; // Re-throw to handle in calling code
            }
            
            // Set up view button
            const viewBtn = document.getElementById('view-btn');
            if (viewBtn) {
                viewBtn.onclick = () => {
                    // Pass the first capture compass heading for proper orientation
                    this.viewPanorama(finalCanvas, this.firstCaptureCompassHeading);
                };
            }
            
            // Set up download button with metadata
            const downloadBtn = document.getElementById('download-btn');
            if (downloadBtn) {
                downloadBtn.onclick = async () => {
                    try {
                        const filename = `photosphere_${photosphereStamp(panoramaData.timestamp)}.jpg`;
                        
                        // Use share API with the blob that has metadata
                        await photoSphereSharer.sharePhotosphere(panoramaBlob, filename);
                    } catch (error) {
                        console.error('Share failed:', error);
                    }
                };
            }
            
            // Unlock UI after successful processing
            this.elements.stitchingOverlay.classList.add('is-complete');
            this.unlockProcessingCard();
            
        } catch (error) {
            console.error('Best-pixel stitching failed:', error);
            
            // Mark job as failed if we have one
            if (this.stitchRecovery && this.currentStitchJobId) {
                await this.stitchRecovery.markJobFailed(this.currentStitchJobId, error);
            }
            
            // Unlock UI on error
            this.unlockProcessingCard();
            
            this.elements.statusText.textContent = 'Stitching failed';
            
            // Handle different error types
            let errorMessage = 'Unknown error';
            let userFriendlyMessage = '';
            
            if (error instanceof Error) {
                errorMessage = error.message;
                
                // Provide user-friendly messages for common errors
                if (errorMessage.includes('cancelled')) {
                    // Processing was cancelled - already handled
                    return;
                } else if (errorMessage.includes('timeout')) {
                    userFriendlyMessage = 'Processing took too long. Try with fewer images or refresh the page.';
                } else if (errorMessage.includes('memory')) {
                    userFriendlyMessage = 'Not enough memory available. Close other apps and try again.';
                } else if (errorMessage.includes('WebGL2')) {
                    userFriendlyMessage = 'Your browser does not support WebGL2. Please update your browser.';
                } else if (errorMessage.includes('No captured images')) {
                    userFriendlyMessage = 'No images found. Please capture images first.';
                } else if (errorMessage.includes('Worker')) {
                    userFriendlyMessage = 'Image processing failed. The app will retry with an alternative method.';
                } else {
                    userFriendlyMessage = `Processing failed: ${errorMessage}`;
                }
            } else if (error instanceof Event) {
                errorMessage = 'Failed to load image data';
                userFriendlyMessage = 'Could not load images. Please try again.';
            } else if (typeof error === 'string') {
                errorMessage = error;
                userFriendlyMessage = error;
            }
            
            this.elements.stitchingOverlay.classList.add('is-failed');
            this.elements.statusDetails.textContent = errorMessage;
            
            // Show error to user
            if (this.cardUI) {
                await this.cardUI.alert(
                    userFriendlyMessage,
                    'Processing Error'
                );
            }
            
            // Offer recovery options
            if (errorMessage.includes('memory') || errorMessage.includes('timeout')) {
                const retry = await this.cardUI.confirm(
                    'Would you like to try again with reduced quality settings?',
                    'Retry Options'
                );
                
                if (retry) {
                    // Set emergency mode flag and retry
                    this.stitchProcessor.metrics.emergencyMode = true;
                    await this.startBestPixelStitching();
                    return;
                }
            }
            
            // Return to capture mode
            this.elements.stitchingOverlay.classList.add('pressing-down');
            setTimeout(() => {
                this.elements.stitchingOverlay.classList.remove('visible', 'pressing-down');
            }, 300);
            
            this.setCapturingEnabled(true);
            document.getElementById('scene-container').style.display = 'block';
            document.getElementById('camera-viewport').style.display = 'block';
            document.getElementById('alignment-indicator').style.display = 'block';
            document.getElementById('instructions').style.display = 'block';
            const bottomControls = document.querySelector('.bottom-controls');
            if (bottomControls) {
                bottomControls.style.display = 'flex';
            }
        }
    }
    
    drawToPortraitCanvas(img, targetW, targetH) {
        // Handle both Image and ImageBitmap objects
        const srcW = img.naturalWidth || img.width;
        const srcH = img.naturalHeight || img.height;
        
        // Validate dimensions
        if (!srcW || !srcH) {
            console.error('Invalid image dimensions:', { srcW, srcH, img });
            // Return empty canvas as fallback
            const canvas = document.createElement('canvas');
            canvas.width = targetW;
            canvas.height = targetH;
            return canvas;
        }
        
        const landscape = srcW > srcH;
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        
        const dw = landscape ? srcH : srcW;
        const dh = landscape ? srcW : srcH;
        const s = Math.min(targetW/dw, targetH/dh);
        const drawW = dw * s, drawH = dh * s;
        const dx = (targetW - drawW)/2, dy = (targetH - drawH)/2;
        
        if (landscape) {
            ctx.save();
            ctx.translate(dx, dy + drawH);
            ctx.rotate(-Math.PI/2);
            ctx.drawImage(img, 0, 0, srcW, srcH, 0, 0, drawH, drawW);
            ctx.restore();
        } else {
            ctx.drawImage(img, 0, 0, srcW, srcH, dx, dy, drawW, drawH);
        }
        return canvas;
    }
    
    /**
     * Normalize yaw angle to [0, 360] range
     * Handles wraparound for compass headings
     * 
     * @param {number} y - Yaw angle in degrees
     * @returns {number} Normalized angle in [0, 360]
     */
    normYaw(y) {
        let d = y % 360;
        return d < 0 ? d + 360 : d;
    }
    
    /**
     * Compute gain compensation values to normalize exposure differences
     * Simplified approach using known adjacency
     */
    // Exposure gains from overlaps: for every sphere direction two frames both
    // see (well inside their edges, not clipped or near-black), compare their
    // linear lightness. Uses the stitch shader's projection, so pairs match the
    // pixels the shader actually blends. Browser cameras re-expose per frame
    // (frames facing the sun come out darker), and whole-frame averages mistake
    // that for scene content. Returns Float32Array or null.
    computeOverlapGains(layers, canvases, tanHalfHF, tanHalfVF) {
        const n = Math.min(layers.length, 40);  // shader MAX_LAYERS
        if (n < 2) return null;
        const SW = 72, SH = 128;  // small copies of each frame for sampling
        const frames = [];
        for (let i = 0; i < n; i++) {
            frames.push(boxDown(canvases[i], SW, SH));
        }
        const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        const MIDTONE_MAX = parseFloat(sessionStorage.getItem('gainMidMax') ?? '0.4'), MIDTONE_MIN = parseFloat(sessionStorage.getItem('gainMidMin') ?? '0.01');
        const SLOPE_RIDGE = parseFloat(sessionStorage.getItem('gainSlopeRidge') ?? '2'), SLOPE_MAX = 1.2;  // 1.2 = e^1.2 = 3.3x across a frame at most
        const GAIN_RANGE = parseFloat(sessionStorage.getItem('gainRange') ?? '8');
        const rot = layers.slice(0, n).map((l) => {
            const y = l.yaw * Math.PI / 180, p = l.pitch * Math.PI / 180, r = (l.roll || 0) * Math.PI / 180;
            return [Math.cos(y), Math.sin(y), Math.cos(p), Math.sin(p), Math.cos(r), Math.sin(r)];
        });
        // Per frame: a log gain a plus a slope across the frame (b vertical,
        // c horizontal). Auto-exposure sets each frame by its own content, so
        // the frame that looks at sky and treetops is 3x darker in the trees
        // than its neighbour below that looks at trees and ground, while its
        // sky matches the frames beside it. One gain per frame cannot satisfy
        // both and broke the sky into blocks; a slope can.
        const pairs = new Map();  // "i,j" -> samples [r, ui, vi, uj, vj], r = log(li / lj)
        const hits = [];
        for (let lat = -80; lat <= 80; lat += 1) {
            const la = lat * Math.PI / 180, cl = Math.cos(la), sl = Math.sin(la);
            for (let lon = -180; lon < 180; lon += 1) {
                const lo = lon * Math.PI / 180;
                const wx = cl * Math.sin(lo), wy = sl, wz = cl * Math.cos(lo);
                hits.length = 0;
                for (let i = 0; i < n; i++) {
                    const [cy, sy, cp, sp, cr, sr] = rot[i];
                    const tx = cy * wx + sy * wz, tz = -sy * wx + cy * wz;
                    const t2y = cp * wy + sp * tz, t2z = -sp * wy + cp * tz;
                    const cx = cr * tx - sr * t2y, cyy = sr * tx + cr * t2y;
                    if (t2z <= 0) continue;
                    const xn = cx / t2z, yn = cyy / t2z;
                    if (Math.abs(xn) > 0.8 * tanHalfHF || Math.abs(yn) > 0.8 * tanHalfVF) continue;
                    const u = xn / (2 * tanHalfHF) + 0.5, v = yn / (2 * tanHalfVF) + 0.5;
                    const px = Math.min(SW - 1, Math.floor(u * SW)), py = Math.min(SH - 1, Math.floor(v * SH));
                    const k = (py * SW + px) * 4, d = frames[i];
                    const mx = Math.max(d[k], d[k + 1], d[k + 2]);
                    if (mx > 245 || mx < 12) continue;  // clipped or too dark to compare
                    const lum = 0.2126 * lin(d[k]) + 0.7152 * lin(d[k + 1]) + 0.0722 * lin(d[k + 2]);
                    // Mid-tones only: above ~0.4 (sRGB 170) the camera's tone curve compresses highlights.
                    if (lum > MIDTONE_MAX || lum < MIDTONE_MIN) continue;
                    hits.push([i, lum, u, v]);
                }
                for (let a = 0; a < hits.length; a++) for (let b = a + 1; b < hits.length; b++) {
                    let [i, li, ui, vi] = hits[a], [j, lj, uj, vj] = hits[b];
                    if (i > j) [i, li, ui, vi, j, lj, uj, vj] = [j, lj, uj, vj, i, li, ui, vi];
                    const key = `${i},${j}`;
                    if (!pairs.has(key)) pairs.set(key, []);
                    pairs.get(key).push([Math.log(li / lj), ui, vi, uj, vj]);
                }
            }
        }
        // Per pair, a robust offset in each of 3x2 position bins of frame i
        // (median log ratio, mean positions), so the slopes are observable.
        const eq = [];
        for (const [key, rs] of pairs) {
            if (rs.length < 30) continue;
            const [i, j] = key.split(',').map(Number), bins = new Map();
            for (const smp of rs) {
                const bk = Math.min(2, Math.floor(smp[2] * 3)) * 2 + Math.min(1, Math.floor(smp[1] * 2));
                if (!bins.has(bk)) bins.set(bk, []);
                bins.get(bk).push(smp);
            }
            for (const b of bins.values()) {
                if (b.length < 25) continue;
                b.sort((x, y) => x[0] - y[0]);
                const m = (k) => b.reduce((acc, smp) => acc + smp[k], 0) / b.length;
                eq.push({ i, j, d: b[b.length >> 1][0], w: Math.sqrt(b.length), ui: m(1) - 0.5, vi: m(2) - 0.5, uj: m(3) - 0.5, vj: m(4) - 0.5 });
            }
        }
        if (eq.length < n - 1) return null;
        // Unknowns per frame: [a, b, c]. Each bin: a_i + b_i vi + c_i ui - a_j - b_j vj - c_j uj = -d.
        // Weak ridge pulls slopes to 0 and a to 0; the median a is removed afterwards.
        const N = 3 * n, x = new Float64Array(N);
        const solve = (edges) => {
            const A = Array.from({ length: N }, () => new Float64Array(N)), rhs = new Float64Array(N);
            for (let k = 0; k < n; k++) { A[3 * k][3 * k] += 1e-3; A[3 * k + 1][3 * k + 1] += SLOPE_RIDGE; A[3 * k + 2][3 * k + 2] += SLOPE_RIDGE; }
            for (const e of edges) {
                const row = [[3 * e.i, 1], [3 * e.i + 1, e.vi], [3 * e.i + 2, e.ui], [3 * e.j, -1], [3 * e.j + 1, -e.vj], [3 * e.j + 2, -e.uj]];
                for (const [p, vp] of row) {
                    for (const [q, vq] of row) A[p][q] += e.w * vp * vq;
                    rhs[p] += e.w * vp * -e.d;
                }
            }
            for (let c = 0; c < N; c++) {  // Gaussian elimination with partial pivoting
                let piv = c;
                for (let r = c + 1; r < N; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
                [A[c], A[piv]] = [A[piv], A[c]]; [rhs[c], rhs[piv]] = [rhs[piv], rhs[c]];
                for (let r = c + 1; r < N; r++) {
                    const f = A[r][c] / A[c][c];
                    if (!f) continue;
                    for (let q = c; q < N; q++) A[r][q] -= f * A[c][q];
                    rhs[r] -= f * rhs[c];
                }
            }
            for (let r = N - 1; r >= 0; r--) {
                let acc = rhs[r];
                for (let q = r + 1; q < N; q++) acc -= A[r][q] * x[q];
                x[r] = acc / A[r][r];
            }
        };
        const residual = (e) => x[3 * e.i] + x[3 * e.i + 1] * e.vi + x[3 * e.i + 2] * e.ui - x[3 * e.j] - x[3 * e.j + 1] * e.vj - x[3 * e.j + 2] * e.uj + e.d;
        solve(eq);
        const kept = eq.filter((e) => Math.abs(residual(e)) <= 0.25);
        if (kept.length >= n - 1) solve(kept);
        const sorted = Array.from({ length: n }, (_, k) => x[3 * k]).sort((a, b) => a - b), mid = sorted[n >> 1];
        const gains = new Float32Array(layers.length).fill(1), slopes = new Float32Array(layers.length * 2);
        let clamped = 0, maxSlope = 0;
        for (let i = 0; i < n; i++) {
            const g = Math.exp(x[3 * i] - mid);
            // Allow large exposure differences while bounding unstable fits.
            // Compress highlights with one capture-wide curve rather than
            // reducing bright frames' gains independently and breaking matches.
            gains[i] = Math.max(1 / GAIN_RANGE, Math.min(GAIN_RANGE, g));
            if (g < 1 / GAIN_RANGE || g > GAIN_RANGE) clamped++;
            slopes[2 * i] = Math.max(-SLOPE_MAX, Math.min(SLOPE_MAX, x[3 * i + 1]));
            slopes[2 * i + 1] = Math.max(-SLOPE_MAX, Math.min(SLOPE_MAX, x[3 * i + 2]));
            maxSlope = Math.max(maxSlope, Math.abs(slopes[2 * i]), Math.abs(slopes[2 * i + 1]));
        }
        gains.slopes = slopes;  // per frame [vertical, horizontal] log-gain per frame width/height
        gains.whitePoint = whitePoint(gains, slopes, n);  // the shader's shoulder maps it to 1
        console.log(`Overlap gains from ${kept.length}/${eq.length} bins (${clamped} clamped, max slope ${maxSlope.toFixed(2)}): ${Array.from(gains.slice(0, n), (g) => g.toFixed(2)).join(' ')}`);
        this._stitchLog?.push(`gains ${kept.length}/${eq.length} bins (${clamped} clamped, max slope ${maxSlope.toFixed(2)})`);
        return gains;
    }

    async computeGainCompensation(layers, canvases) {
        const gains = new Float32Array(layers.length);
        gains.fill(1.0);
        
        // Skip gain compensation if disabled
        const disableGainComp = sessionStorage.getItem('disableGainCompensation') === 'true';
        if (disableGainComp) {
            console.log('Gain compensation disabled');
            return gains;
        }
        
        try {
        
        console.log(`Computing gain compensation for ${layers.length} images`);
        
        // First, compute average brightness for each image
        const brightness = new Float32Array(layers.length);
        for (let i = 0; i < canvases.length; i++) {
            const canvas = canvases[i];
            const ctx = canvas.getContext('2d');
            
            // Sample the image to get average brightness
            const step = 20; // Sample every 20th pixel for speed
            let sum = 0;
            let count = 0;
            
            try {
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imageData.data;
                
                for (let y = 0; y < canvas.height; y += step) {
                    for (let x = 0; x < canvas.width; x += step) {
                        const idx = (y * canvas.width + x) * 4;
                        // Convert to luminance
                        const r = data[idx] / 255;
                        const g = data[idx + 1] / 255;
                        const b = data[idx + 2] / 255;
                        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                        if (lum > 0.01) { // Skip very dark pixels
                            sum += lum;
                            count++;
                        }
                    }
                }
                
                brightness[i] = count > 0 ? sum / count : 0.5;
                console.log(`Image ${i} (hotspot ${layers[i].hotspotId}): brightness=${brightness[i].toFixed(3)}`);
            } catch (e) {
                console.warn(`Failed to compute brightness for image ${i}:`, e);
                brightness[i] = 0.5;
            }
        }
        
        // Use known adjacency from hotspot pattern
        const { Hotspots } = await import('./hotspots.js');
        const adjacencyGraph = Hotspots.getMatchingGraph();
        
        // Build list of adjacent pairs
        const adjacentPairs = [];
        const hotspotToIndex = new Map();
        
        // Map hotspot IDs to layer indices
        for (let i = 0; i < layers.length; i++) {
            const hotspotId = layers[i].hotspotId;
            if (hotspotId) {
                hotspotToIndex.set(hotspotId, i);
            }
        }
        
        // Find all adjacent pairs
        for (let i = 0; i < layers.length; i++) {
            const hotspotId = layers[i].hotspotId;
            if (!hotspotId) continue;
            
            const neighbors = adjacencyGraph[hotspotId.toString()] || [];
            for (const neighborId of neighbors) {
                const j = hotspotToIndex.get(parseInt(neighborId));
                if (j !== undefined && j > i) { // Only process each pair once
                    const ratio = brightness[i] / brightness[j];
                    adjacentPairs.push({ i, j, ratio });
                    console.log(`Adjacent ${hotspotId}-${neighborId}: brightness ratio=${ratio.toFixed(2)}`);
                }
            }
        }
        
        console.log(`Found ${adjacentPairs.length} adjacent image pairs`);
        
        if (adjacentPairs.length === 0) {
            console.warn('No adjacent pairs found for gain compensation');
            return gains;
        }
        
        // Simple gain optimization: make all images have similar brightness
        // Target brightness is the median brightness
        const sortedBrightness = [...brightness].sort((a, b) => a - b);
        const targetBrightness = sortedBrightness[Math.floor(sortedBrightness.length / 2)];
        
        console.log(`Target brightness: ${targetBrightness.toFixed(3)}`);
        
        // Set gains to normalize each image to target brightness
        for (let i = 0; i < layers.length; i++) {
            if (brightness[i] > 0) {
                gains[i] = targetBrightness / brightness[i];
                // Clamp gains to reasonable range
                gains[i] = Math.max(0.5, Math.min(2.0, gains[i]));
                console.log(`Image ${i}: gain=${gains[i].toFixed(2)}`);
            }
        }
        
        // Optional: Iterative refinement based on adjacent pairs
        const maxIterations = 5;
        const convergenceThreshold = 0.01;
        const dampingFactor = 0.3; // Slower updates for stability
        
        for (let iter = 0; iter < maxIterations; iter++) {
            const updates = new Float32Array(layers.length);
            const counts = new Float32Array(layers.length);
            
            // Accumulate gain adjustments from all adjacent pairs
            let totalError = 0;
            for (const pair of adjacentPairs) {
                const { i, j, ratio } = pair;
                // Current intensity ratio with gains applied
                const currentRatio = (gains[i] / gains[j]) * ratio;
                // Error from ideal ratio of 1.0
                const error = Math.log(currentRatio);
                totalError += Math.abs(error);
                
                // Distribute error proportionally
                updates[i] -= error * 0.5;
                updates[j] += error * 0.5;
                counts[i] += 1;
                counts[j] += 1;
            }
            
            // Apply updates with damping
            let maxUpdate = 0;
            for (let i = 0; i < layers.length; i++) {
                if (counts[i] > 0) {
                    const update = updates[i] / counts[i];
                    const dampedUpdate = update * dampingFactor;
                    gains[i] *= Math.exp(dampedUpdate);
                    maxUpdate = Math.max(maxUpdate, Math.abs(dampedUpdate));
                }
            }
            
            // Normalize to geometric mean of 1.0 (better than arithmetic mean)
            const logSum = gains.reduce((sum, g) => sum + Math.log(g), 0);
            const geoMean = Math.exp(logSum / gains.length);
            for (let i = 0; i < gains.length; i++) {
                gains[i] /= geoMean;
            }
            
            // Check convergence
            const avgError = adjacentPairs.length > 0 ? totalError / adjacentPairs.length : 0;
            if (maxUpdate < convergenceThreshold || avgError < 0.01) {
                console.log(`Gain compensation converged in ${iter + 1} iterations (avg error: ${avgError.toFixed(4)})`);
                break;
            }
        }
        
        // Apply gentle smoothing to neighboring gains to avoid sharp transitions
        const smoothedGains = new Float32Array(gains);
        for (let i = 0; i < layers.length; i++) {
            let sum = gains[i] * 2; // Weight current gain more
            let count = 2;
            
            // Add adjacent neighbors' gains for smoothing
            const hotspotId = layers[i].hotspotId;
            if (hotspotId) {
                const neighbors = adjacencyGraph[hotspotId.toString()] || [];
                for (const neighborId of neighbors) {
                    const j = hotspotToIndex.get(parseInt(neighborId));
                    if (j !== undefined) {
                        sum += gains[j];
                        count++;
                    }
                }
            }
            
            smoothedGains[i] = sum / count;
        }
        
        // Clamp gains to reasonable range (allow wider range for testing)
        for (let i = 0; i < smoothedGains.length; i++) {
            smoothedGains[i] = Math.max(0.5, Math.min(2.0, smoothedGains[i]));
        }
        
        console.log('Computed exposure gains:', smoothedGains);
        return smoothedGains;
        
        } catch (error) {
            console.error('Error computing gain compensation:', error);
            // Return default gains rather than crashing
            return gains;
        }
    }
    
    /**
     * Compute intensity ratio between overlapping regions of two images
     */
    async computeIntensityRatio(canvas1, layer1, canvas2, layer2) {
        // More focused sampling in actual overlap region
        const ctx1 = canvas1.getContext('2d');
        const ctx2 = canvas2.getContext('2d');
        
        const HFOVdeg = 44, VFOVdeg = 73;
        const tanHalfHF = Math.tan(Math.PI * HFOVdeg / 360);
        const tanHalfVF = Math.tan(Math.PI * VFOVdeg / 360);
        
        // Calculate overlap region more precisely
        const yaw1 = layer1.yaw * Math.PI / 180;
        const yaw2 = layer2.yaw * Math.PI / 180;
        const pitch1 = layer1.pitch * Math.PI / 180;
        const pitch2 = layer2.pitch * Math.PI / 180;
        
        // Sample in a focused grid around the overlap center
        const samples = 30; // More samples for better accuracy
        const values1 = [];
        const values2 = [];
        
        // Sample in a grid centered between the two camera positions
        const centerYaw = (yaw1 + yaw2) / 2;
        const centerPitch = (pitch1 + pitch2) / 2;
        const sampleRange = Math.PI / 6; // 30 degree sampling range
        
        for (let si = 0; si < samples; si++) {
            for (let sj = 0; sj < samples; sj++) {
                // Generate world direction in overlap region
                const lon = centerYaw + (si / (samples - 1) - 0.5) * sampleRange;
                const lat = centerPitch + (sj / (samples - 1) - 0.5) * sampleRange;
                
                // Clamp latitude to valid range
                const clampedLat = Math.max(-Math.PI/2, Math.min(Math.PI/2, lat));
                
                const worldDir = {
                    x: Math.cos(clampedLat) * Math.sin(lon),
                    y: Math.sin(clampedLat),
                    z: Math.cos(clampedLat) * Math.cos(lon)
                };
                
                // Project to both cameras
                const uv1 = this.projectToCamera(worldDir, layer1, tanHalfHF, tanHalfVF);
                const uv2 = this.projectToCamera(worldDir, layer2, tanHalfHF, tanHalfVF);
                
                // If visible in both cameras and not at edges, sample pixels
                if (uv1 && uv2 && 
                    uv1.u > 0.1 && uv1.u < 0.9 && uv1.v > 0.1 && uv1.v < 0.9 &&
                    uv2.u > 0.1 && uv2.u < 0.9 && uv2.v > 0.1 && uv2.v < 0.9) {
                    
                    const x1 = Math.floor(uv1.u * canvas1.width);
                    const y1 = Math.floor(uv1.v * canvas1.height);
                    const x2 = Math.floor(uv2.u * canvas2.width);
                    const y2 = Math.floor(uv2.v * canvas2.height);
                    
                    try {
                        const pixel1 = ctx1.getImageData(x1, y1, 1, 1).data;
                        const pixel2 = ctx2.getImageData(x2, y2, 1, 1).data;
                        
                        // Convert to luminance (use linear space for accuracy)
                        const r1 = Math.pow(pixel1[0] / 255, 2.2);
                        const g1 = Math.pow(pixel1[1] / 255, 2.2);
                        const b1 = Math.pow(pixel1[2] / 255, 2.2);
                        const lum1 = 0.2126 * r1 + 0.7152 * g1 + 0.0722 * b1;
                        
                        const r2 = Math.pow(pixel2[0] / 255, 2.2);
                        const g2 = Math.pow(pixel2[1] / 255, 2.2);
                        const b2 = Math.pow(pixel2[2] / 255, 2.2);
                        const lum2 = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
                        
                        // Only use pixels with reasonable brightness
                        if (lum1 > 0.01 && lum2 > 0.01) {
                            values1.push(lum1);
                            values2.push(lum2);
                        }
                    } catch (e) {
                        // Ignore out of bounds
                    }
                }
            }
        }
        
        // Need sufficient samples for reliable ratio
        if (values1.length < 20) {
            console.log(`Not enough overlap samples: ${values1.length} < 20`);
            // Try to return a ratio if we have at least some samples
            if (values1.length >= 5) {
                const avgLum1 = values1.reduce((a, b) => a + b, 0) / values1.length;
                const avgLum2 = values2.reduce((a, b) => a + b, 0) / values2.length;
                return avgLum1 / avgLum2;
            }
            return 0; // Not enough overlap
        }
        
        // Use median ratio for robustness against outliers
        const ratios = [];
        for (let i = 0; i < values1.length; i++) {
            ratios.push(values1[i] / values2[i]);
        }
        ratios.sort((a, b) => a - b);
        
        // Return median ratio
        const medianRatio = ratios[Math.floor(ratios.length / 2)];
        
        // Sanity check
        if (medianRatio < 0.1 || medianRatio > 10) {
            return 0; // Unrealistic ratio
        }
        
        return medianRatio;
    }
    
    /**
     * Apply vignetting correction to a single canvas, BEFORE stitching.
     * Lens falloff is corrected in linear light: brightness x exp(0.15 *
     * strength * r^2), r = distance from center / half-diagonal. Measured from
     * overlaps in four Stanford sessions (iPhone, 720x1280): corners 0.87x and
     * sides 0.95x of center. The old curve scaled sRGB bytes by up to 1.56
     * (2.6x in linear light), which brightened every frame corner and clipped it.
     */
    applyVignettingCorrection(canvas, strength) {
        try {
            const ctx = canvas.getContext('2d');
            const w = canvas.width;
            const h = canvas.height;
            const imageData = ctx.getImageData(0, 0, w, h);
            const data = imageData.data;
            const toLin = new Float32Array(256);
            for (let i = 0; i < 256; i++) { const c = i / 255; toLin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
            const STEPS = 4096, toByte = new Uint8Array(STEPS + 1);  // linear 0..1 -> sRGB byte
            for (let i = 0; i <= STEPS; i++) { const c = i / STEPS; toByte[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); }
            const half2 = (w / 2) ** 2 + (h / 2) ** 2, R2 = 1024, gainLUT = new Float32Array(R2 + 1);  // by r^2
            for (let i = 0; i <= R2; i++) gainLUT[i] = Math.exp(0.15 * strength * i / R2) * STEPS;
            for (let y = 0; y < h; y++) {
                const dy2 = (y + 0.5 - h / 2) ** 2;
                for (let x = 0; x < w; x++) {
                    const k = gainLUT[Math.min(R2, (((x + 0.5 - w / 2) ** 2 + dy2) / half2 * R2) | 0)];
                    const idx = (y * w + x) * 4;
                    data[idx] = toByte[Math.min(STEPS, (toLin[data[idx]] * k) | 0)];
                    data[idx + 1] = toByte[Math.min(STEPS, (toLin[data[idx + 1]] * k) | 0)];
                    data[idx + 2] = toByte[Math.min(STEPS, (toLin[data[idx + 2]] * k) | 0)];
                }
            }
            ctx.putImageData(imageData, 0, 0);
        } catch (error) {
            console.error('Error applying vignetting correction:', error);
            // Continue without correction rather than crashing
        }
    }
    
    /**
     * Project world direction to camera UV coordinates
     */
    projectToCamera(worldDir, layer, tanHalfHF, tanHalfVF) {
        const yaw = layer.yaw * Math.PI / 180;
        const pitch = layer.pitch * Math.PI / 180;
        const roll = (layer.roll || 0) * Math.PI / 180;
        
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        const cp = Math.cos(pitch), sp = Math.sin(pitch);
        const cr = Math.cos(roll), sr = Math.sin(roll);
        
        // Apply inverse rotations (yaw, pitch, roll)
        let temp = {
            x: cy * worldDir.x + sy * worldDir.z,
            y: worldDir.y,
            z: -sy * worldDir.x + cy * worldDir.z
        };
        
        let temp2 = {
            x: temp.x,
            y: cp * temp.y + sp * temp.z,
            z: -sp * temp.y + cp * temp.z
        };
        
        let camDir = {
            x: cr * temp2.x - sr * temp2.y,
            y: sr * temp2.x + cr * temp2.y,
            z: temp2.z
        };
        
        if (camDir.z <= 0) return null; // Behind camera
        
        const xn = camDir.x / camDir.z;
        const yn = camDir.y / camDir.z;
        
        if (Math.abs(xn) > tanHalfHF || Math.abs(yn) > tanHalfVF) {
            return null; // Outside FOV
        }
        
        const u = (xn / (2 * tanHalfHF)) + 0.5;
        const v = (yn / (2 * tanHalfVF)) + 0.5;
        
        return { u, v };
    }

    async renderBestPixelPanorama(gl, erpCanvas, layers, calibratedFOV, seamAlignments = []) {
        this._stitchLog = [];  // one line per stage; saved in the JPEG's XMP description
        // WebGL2 shader setup
        const vs = `#version 300 es
        precision highp float;
        layout(location=0) in vec2 pos;
        out vec2 v_uv;
        void main(){ v_uv = 0.5*pos + 0.5; gl_Position = vec4(pos,0,1); }`;
        
        const fs = `#version 300 es
        precision highp float;
        precision highp sampler2DArray;
        in vec2 v_uv;
        out vec4 frag;
        uniform sampler2DArray tiles;
        uniform int layerCount;
        // Per-frame data packed into vec4s (one uniform vector each, so 40 frames
        // fit well inside mobile limits): camPose = yaw, pitch, roll, gain;
        // layerAux = ERP center u, v, horizontal offset, manual roll.
        uniform vec4 camPose[40];
        uniform vec4 layerAux[40];
        uniform vec4 gainSlope[40];  // x: log gain per frame height (v), y: per frame width (u)
        uniform float tanHalfHF;
        uniform float tanHalfVF;
        uniform float pi;
        uniform float threshold;
        // NEW: Voronoi bias inputs
        uniform float voronoiBias; // ~1.0–2.0 is a good start
        // Seam alignment offsets (horizontal and vertical)
        // 1 = sky reference: soft average of every covering frame (alpha 0 where none).
        uniform int refMode;
        // Score width of the seam cross-fade (0 = hard best-pixel cuts).
        uniform float seamFeather;
        uniform float agreeLo, agreeHi;  // color difference where the fade starts/stops shrinking
        // Routed seams: per-frame blend share on a low-res grid (linear-filtered);
        // the frames covering a pixel are mixed by their shares.
        uniform int useLabels;
        uniform sampler2DArray maskTex;
        // Per-frame local warp: displacement grids (fractions of the frame,
        // byte 127 = 0, +-0.1 range); the frame is sampled at (u,v) - D(u,v).
        uniform int useWarp;
        uniform vec2 warpGrid;
        uniform sampler2DArray warpTex;
        // Capture-wide extended Reinhard curve, matching shoulder() in
        // seam-finder.js. Scale RGB together to preserve their ratios, retaining
        // highlight contrast instead of flattening gained values above white.
        uniform float whitePoint;
        vec3 shoulder(vec3 c) {
          float m = max(max(c.r, c.g), c.b);
          if (whitePoint <= 1.0) return c;
          return c * ((1.0 + m / (whitePoint * whitePoint)) / (1.0 + m));
        }
      
        vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
        vec3 toSRGB(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0/2.2)); }
      
        float quality(float xn, float yn, float tanH, float tanV) {
          float dx = abs(xn) / tanH;
          float dy = abs(yn) / tanV;
          float dist = sqrt(dx*dx + dy*dy);
          return 1.0 - dist;
        }
      
        // NEW: toroidal ERP distance so seams near u=0/1 don't blow up
        float erpDistance(vec2 a, vec2 b){
          float du = abs(a.x - b.x);
          du = min(du, 1.0 - du); // wrap horizontally
          float dv = a.y - b.y;   // no wrap vertical
          return sqrt(du*du + dv*dv);
        }
      
        void main(){
          float lon = 2.0*pi*v_uv.x - pi;
          float lat = pi*(0.5 - v_uv.y);
      
          vec3 worldDir = vec3(
            cos(lat) * sin(lon),
            sin(lat),
            cos(lat) * cos(lon)
          );
      
          vec3 bestColor = vec3(0.0);
          float bestScore = -1e9;   // NEW: use score (not just q)
          int bestLayer = -1;
          vec3 secondColor = vec3(0.0);
          float secondScore = -1e9;
      
          vec3 accumColor = vec3(0.0);
          float accumWeight = 0.0;
          vec3 softColor = vec3(0.0);
          float softWeight = 0.0;
          vec3 mCol = vec3(0.0);
          float mSum = 0.0;
      
          for (int l = 0; l < 40; ++l) {
            if (l >= layerCount) break;
      
            float yaw = camPose[l].x;
            float pitch = camPose[l].y;
            float roll = camPose[l].z;
      
            float cy = cos(yaw), sy = sin(yaw);
            float cp = cos(pitch), sp = sin(pitch);
            float cr = cos(roll), sr = sin(roll);
      
            // yaw
            vec3 temp = vec3(
              cy * worldDir.x + sy * worldDir.z,
              worldDir.y,
              -sy * worldDir.x + cy * worldDir.z
            );
            // pitch
            vec3 temp2 = vec3(
              temp.x,
              cp * temp.y + sp * temp.z,
              -sp * temp.y + cp * temp.z
            );
            // roll
            vec3 camDir = vec3(
              cr * temp2.x - sr * temp2.y,
              sr * temp2.x + cr * temp2.y,
              temp2.z
            );
      
            if (camDir.z <= 0.0) continue;
      
            float xn = camDir.x / camDir.z;
            float yn = camDir.y / camDir.z;
      
            if (abs(xn) > tanHalfHF || abs(yn) > tanHalfVF) continue;
      
            float u = (xn / (2.0*tanHalfHF)) + 0.5;
            float v = (yn / (2.0*tanHalfVF)) + 0.5;

            // Apply alignment offsets (for all images, not just equator)
            // Convert pixel offsets to UV offsets
            float pixelOffsetH = layerAux[l].z;
            float pixelOffsetV = layerAux[l].w;
            float textureWidth = 1080.0;  // Adjust based on actual resolution
            float textureHeight = 1920.0; // Portrait mode

            // Apply horizontal offset if any
            u += pixelOffsetH / textureWidth;

            // Optional manual roll knob (radians). Per-frame roll is already
            // applied geometrically via camRoll; this is only the user override.
            float rollCompRad = layerAux[l].w;
            if (abs(rollCompRad) > 0.001) {
                float cosR = cos(rollCompRad);
                float sinR = sin(rollCompRad);

                // Rotate UV coordinates around center to level the image
                float uCentered = u - 0.5;
                float vCentered = v - 0.5;
                u = cosR * uCentered - sinR * vCentered + 0.5;
                v = sinR * uCentered + cosR * vCentered + 0.5;
            }

            if (useWarp == 1) {
              vec2 tc = (vec2(u, v) * (warpGrid - 1.0) + 0.5) / warpGrid;
              vec2 d = (texture(warpTex, vec3(tc, float(l))).rg * 255.0 - 127.0) / 254.0 * 0.2;
              u -= d.x; v -= d.y;
            }
            if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) continue;

            vec3 raw = texture(tiles, vec3(u, v, float(l))).rgb;
            vec3 s = toLin(raw);
            // Clipped samples hand their blend share to frames that saw the
            // spot unclipped (the seam finder avoids them too: clipAmount()).
            float clipped = smoothstep(230.0 / 255.0, 250.0 / 255.0, max(max(raw.r, raw.g), raw.b));
            float unclipped = 1.0 - 0.95 * clipped;
            // A clipped pixel says nothing about exposure, so a frame being
            // darkened leaves it as captured (two frames that both clipped the
            // sky otherwise rendered it at two brightnesses).
            float g = camPose[l].w * exp(gainSlope[l].x * (v - 0.5) + gainSlope[l].y * (u - 0.5));
            if (g < 1.0) g = pow(g, 1.0 - clipped);
            s = shoulder(s * g);
            if (useLabels == 1) {
              // The share fades over the frame's outer 15% (RIM in
              // seam-finder.js) and is 0 in the last 2.5%: the grid can claim up
              // to a block past the true edge (a stepped outline), and the rim is
              // the least accurate part of a frame (a roof along one frame's edge
              // ghosted into the sky). Where only rims cover, the best-pixel
              // color above is used.
              float m = texture(maskTex, vec3(v_uv, float(l))).r * smoothstep(0.05, 0.3, 1.0 - 2.0 * max(abs(u - 0.5), abs(v - 0.5))) * unclipped;
              mCol += m * s; mSum += m;
            }
      
            float q = quality(xn, yn, tanHalfHF, tanHalfVF);
      
            // NEW: Voronoi-biased score (stabilizes seams)
            // Angle from this frame's optical axis, in turns (1 = 360 deg). The old
            // ERP-uv distance stretched longitude near the poles, so the zenith
            // seam came out wavy and too steep to cross-fade.
            float d = acos(clamp(camDir.z, -1.0, 1.0)) / (2.0 * pi);
            float score = q - voronoiBias * d;
      
            if (score > bestScore) {
              secondScore = bestScore;
              secondColor = bestColor;
              bestScore = score;
              bestColor = s;
              bestLayer = l;
            } else if (score > secondScore) {
              secondScore = score;
              secondColor = s;
            }
      
            // Sharper blending curve to hide misalignment
            if (q > 0.0) {
              float w = pow(q, 8.0);  // Much sharper falloff to hide alignment issues
              accumColor += s * w;
              accumWeight += w;
              softColor += s * q * q;  // broad overlap averaging for the sky reference
              softWeight += q * q;
            }
          }

          if (refMode == 1) {
            frag = softWeight > 0.0 ? vec4(toSRGB(softColor / softWeight), 1.0) : vec4(0.0);
            return;
          }
      
          vec3 finalColor;
          // Use the original threshold behavior, but based on the *quality*
          // (keeps your intended crisp vs. feather logic)
          if (bestScore > (threshold - voronoiBias * 0.0)) {
            finalColor = bestColor;
          } else if (accumWeight > 0.0) {
            finalColor = accumColor / accumWeight;
          } else {
            finalColor = vec3(0.0);
          }
          // Cross-fade every frame handoff (both branches above; low scores near
          // frame edges took the second one) so seams don't show as hard lines.
          // Exposure/flare steps between frames still fade; high-contrast
          // misaligned detail shrinks the fade to a hard cut, avoiding ghosts.
          if (seamFeather > 0.0 && secondScore > -1e8) {
            float agree = 1.0 - smoothstep(agreeLo, agreeHi, length(bestColor - secondColor));
            float width = seamFeather * agree;
            if (width > 1e-5) {
              float t = clamp((bestScore - secondScore) / width, 0.0, 1.0);
              finalColor = mix(0.5 * (bestColor + secondColor), finalColor, t);
            }
          }
      
          // Routed seams override the nearest-center choice where a frame has a share.
          if (useLabels == 1 && mSum > 1e-4) finalColor = mCol / mSum;
          frag = (bestLayer >= 0) ? vec4(toSRGB(finalColor), 1.0)
                                  : vec4(0.0, 0.0, 0.0, 1.0);
        }`;
      
        // Compile shaders
        function compileShader(type, src) {
          const shader = gl.createShader(type);
          gl.shaderSource(shader, src);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(shader));
          }
          return shader;
        }
      
        const vsShader = compileShader(gl.VERTEX_SHADER, vs);
        const fsShader = compileShader(gl.FRAGMENT_SHADER, fs);
      
        const prog = gl.createProgram();
        gl.attachShader(prog, vsShader);
        gl.attachShader(prog, fsShader);
        gl.bindAttribLocation(prog, 0, 'pos');
        gl.linkProgram(prog);
      
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          throw new Error(gl.getProgramInfoLog(prog));
        }
      
        gl.useProgram(prog);
      
        // Get uniform locations
        const uLoc = {
          tiles: gl.getUniformLocation(prog, 'tiles'),
          layerCount: gl.getUniformLocation(prog, 'layerCount'),
          camPose: gl.getUniformLocation(prog, 'camPose'),
          layerAux: gl.getUniformLocation(prog, 'layerAux'),
          gainSlope: gl.getUniformLocation(prog, 'gainSlope'),
          tanHalfHF: gl.getUniformLocation(prog, 'tanHalfHF'),
          tanHalfVF: gl.getUniformLocation(prog, 'tanHalfVF'),
          pi: gl.getUniformLocation(prog, 'pi'),
          threshold: gl.getUniformLocation(prog, 'threshold'),
          // NEW:
          voronoiBias:   gl.getUniformLocation(prog, 'voronoiBias'),
          refMode: gl.getUniformLocation(prog, 'refMode'),
          seamFeather: gl.getUniformLocation(prog, 'seamFeather'),
          agreeLo: gl.getUniformLocation(prog, 'agreeLo'),
          agreeHi: gl.getUniformLocation(prog, 'agreeHi'),
          useLabels: gl.getUniformLocation(prog, 'useLabels'),
          maskTex: gl.getUniformLocation(prog, 'maskTex'),
          useWarp: gl.getUniformLocation(prog, 'useWarp'),
          warpGrid: gl.getUniformLocation(prog, 'warpGrid'),
          warpTex: gl.getUniformLocation(prog, 'warpTex'),
          whitePoint: gl.getUniformLocation(prog, 'whitePoint'),
        };
      
        // Create vertex buffer
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      
        // Set uniforms - use calibrated FOV if available
        // Use calibrated FOV or fallback to mode-specific defaults
        const captureMode = localStorage.getItem('captureMode') || 'outdoor';
        let BASE_H_FOV, BASE_V_FOV;
        if (captureMode === 'indoor') {
            BASE_H_FOV = 43.2;
            BASE_V_FOV = 2 * Math.atan(Math.tan(43.2 * Math.PI / 360) * (16/9)) * 180 / Math.PI;
        } else {
            BASE_H_FOV = 45.7;
            BASE_V_FOV = 73.3;
        }

        // Check for user fine-tuning offsets
        const hOffset = parseFloat(localStorage.getItem('fov-h-offset') || '0');
        const vOffset = parseFloat(localStorage.getItem('fov-v-offset') || '0');

        // Apply offsets to calibrated values or defaults
        const HFOVdeg = calibratedFOV?.horizontal ?? (BASE_H_FOV + hOffset);
        const VFOVdeg = calibratedFOV?.vertical ?? (BASE_V_FOV + vOffset);
        let tanHalfHF = Math.tan(Math.PI * HFOVdeg / 360);
        let tanHalfVF = Math.tan(Math.PI * VFOVdeg / 360);

        console.log(`Using FOV for stitching: H=${HFOVdeg.toFixed(1)}° V=${VFOVdeg.toFixed(1)}°`);
      
        gl.uniform1f(uLoc.pi, Math.PI);
        gl.uniform1f(uLoc.tanHalfHF, tanHalfHF);
        gl.uniform1f(uLoc.tanHalfVF, tanHalfVF);
        gl.uniform1f(uLoc.threshold, 0.85);  // Increased for harder cuts

        // Higher voronoi bias for more stable seam placement
        gl.uniform1f(uLoc.voronoiBias, 1.5);
      
        // Apply vignetting correction to each canvas BEFORE uploading to GPU
        const vignetteStrength = parseFloat(sessionStorage.getItem('vignetteCorrection') || '1');
        const canvases = layers.map(l => l.canvas);
        
        if (vignetteStrength > 0) {
            console.log(`Applying vignetting correction (strength: ${vignetteStrength})`);
            // Process in batches to avoid blocking
            for (let i = 0; i < canvases.length; i++) {
                this.applyVignettingCorrection(canvases[i], vignetteStrength);
                // Yield to browser every 4 images to prevent blocking
                if (i % 4 === 3) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
        }
        
        const w = canvases[0].width, h = canvases[0].height;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, w, h, canvases.length);
      
        // Upload each canvas to texture array
        // Note: We could optimize this further by creating ImageBitmaps from canvases
        // but the canvas data is already in memory so benefit is minimal
        for (let i = 0; i < canvases.length; i++) {
          const data = canvases[i].getContext('2d').getImageData(0, 0, w, h).data;
          gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
        }
      
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
        gl.uniform1i(uLoc.tiles, 0);
        gl.uniform1i(uLoc.layerCount, canvases.length);
      
        // Set camera orientations
        // Correct sensor poses from what overlapping frames show (optional;
        // sessionStorage imageAlign='0' disables; any failure keeps sensor poses).
        let warps = null, warpGrid = null, warpTexture = null, misfit = null;
        if (sessionStorage.getItem('imageAlign') !== '0') {
          try {
            const t0 = performance.now();
            const summary = this.computeImageAlignment(layers, canvases, tanHalfHF, tanHalfVF);
            if (summary?.warps && sessionStorage.getItem('localWarp') !== '0') { warps = summary.warps; warpGrid = summary.warpGrid; misfit = summary.misfit; }
            console.log(`Image alignment: ${summary?.summary ?? 'not applied'} (${(performance.now() - t0).toFixed(0)} ms)`);
            this._stitchLog.push(`align ${summary?.summary ?? 'not applied'} (${(performance.now() - t0).toFixed(0)} ms)`);
            if (summary?.focalScale) {  // the matches also say how far off the nominal FOV is
              tanHalfHF *= summary.focalScale; tanHalfVF *= summary.focalScale;
              gl.uniform1f(uLoc.tanHalfHF, tanHalfHF);
              gl.uniform1f(uLoc.tanHalfVF, tanHalfVF);
            }
          } catch (e) {
            console.warn('Image alignment failed, using sensor poses:', e);
          }
        }

        const yawArray = new Float32Array(layers.map(l => l.yaw * Math.PI / 180));
        const pitchArray = new Float32Array(layers.map(l => l.pitch * Math.PI / 180));
        const rollArray = new Float32Array(layers.map(l => (l.roll || 0) * Math.PI / 180));
      
        // Exposure gains: overlap-based first; the whole-frame-average method is
        // the fallback (sessionStorage gainMode='legacy' forces it for A/B).
        let computedGains = null;
        if (sessionStorage.getItem('gainMode') !== 'legacy') {
          try {
            const t0 = performance.now();
            computedGains = this.computeOverlapGains(layers, canvases, tanHalfHF, tanHalfVF);
            console.log(`Overlap gains took ${(performance.now() - t0).toFixed(0)} ms`);
          } catch (e) {
            console.warn('Overlap gains failed, using whole-frame gains:', e);
          }
        }
        if (!computedGains) computedGains = await this.computeGainCompensation(layers, canvases);
        
        // Shader holds up to MAX_LAYERS frames; pad gains with 1.0
        const MAX_LAYERS = 40;
        const gains = new Float32Array(MAX_LAYERS);
        gains.fill(1.0); // Default gain
        
        if (computedGains && computedGains.length > 0) {
            for (let i = 0; i < Math.min(computedGains.length, MAX_LAYERS); i++) {
                // Ensure valid gain values
                const gain = computedGains[i];
                if (gain > 0 && gain < 100 && !isNaN(gain)) {
                    gains[i] = gain;
                }
            }
            console.log(`Applied ${computedGains.length} computed gains`);
        } else {
            console.warn('No computed gains, using default values');
        }
        
      
        // NEW: compute and upload layerCenterUV (ERP centers)
        const centerUV = new Float32Array(MAX_LAYERS*2);
        for (let i=0;i<layers.length && i<MAX_LAYERS;i++){
          const [u,v] = this._erpCenterFromYawPitch(layers[i].yaw, layers[i].pitch);
          centerUV[i*2+0] = u;
          centerUV[i*2+1] = v;
        }

        // Set alignment offsets from hybrid alignment
        const alignOffsetsH = new Float32Array(MAX_LAYERS);
        const alignOffsetsV = new Float32Array(MAX_LAYERS);
        for (let i = 0; i < MAX_LAYERS; i++) {
          alignOffsetsH[i] = 0; // Default to no offset
          alignOffsetsV[i] = 0;
        }

        // Apply calculated alignments.
        //
        // Roll is handled geometrically by `camRoll` in the projection (each
        // frame's gravity-referenced accelerometer roll, converted deg->rad).
        // The old "consensus horizon" added a SECOND, redundant in-UV roll that
        // fed simple-aligner's DEGREE-valued rollCompensation into a shader slot
        // applied as RADIANS — a ~57x over-rotation that produced the "shark-fin"
        // frames on any capture with a non-trivial tilt. Removed; roll is now
        // applied exactly once. alignmentOffsetsV carries ONLY the optional manual
        // roll knob (already in radians); alignmentOffsetsH the optional H offset.
        const manualRollCorrection = parseFloat(sessionStorage.getItem('rollCorrection') || '0') * Math.PI / 180;
        if (manualRollCorrection !== 0) {
          console.log(`Applying manual roll correction: ${(manualRollCorrection * 180 / Math.PI).toFixed(2)}°`);
        }

        for (const alignment of seamAlignments) {
          const idx = alignment.from - 1; // Convert hotspot ID to array index
          if (idx >= 0 && idx < MAX_LAYERS) {
            alignOffsetsH[idx] = alignment.horizontal || alignment.offset || 0;
            alignOffsetsV[idx] = manualRollCorrection;
          }
        }
        // Pack per-frame values into the shader's vec4 arrays.
        const camPose = new Float32Array(MAX_LAYERS * 4), layerAux = new Float32Array(MAX_LAYERS * 4), gainSlope = new Float32Array(MAX_LAYERS * 4);
        const slopes = computedGains?.slopes;
        for (let i = 0; i < MAX_LAYERS; i++) {
          camPose.set([yawArray[i] || 0, pitchArray[i] || 0, rollArray[i] || 0, gains[i]], i * 4);
          layerAux.set([centerUV[i * 2], centerUV[i * 2 + 1], alignOffsetsH[i], alignOffsetsV[i]], i * 4);
          if (slopes && 2 * i + 1 < slopes.length) gainSlope.set([slopes[2 * i], slopes[2 * i + 1], 0, 0], i * 4);
        }
        gains.slopes = slopes;  // the seam finder applies the same field
        gains.whitePoint = computedGains?.whitePoint ?? Math.max(1, ...gains);
        gl.uniform1f(uLoc.whitePoint, gains.whitePoint);
        gl.uniform4fv(uLoc.camPose, camPose);
        gl.uniform4fv(uLoc.layerAux, layerAux);
        gl.uniform4fv(uLoc.gainSlope, gainSlope);

        // Route seams through places where overlapping frames agree (optional;
        // sessionStorage seamRouting='0' keeps nearest-center seams). The samplers
        // always get their own units so they never alias the frame array on unit 0.
        gl.uniform1i(uLoc.maskTex, 1);
        gl.uniform1i(uLoc.useLabels, 0);
        gl.uniform1i(uLoc.warpTex, 3);
        gl.uniform1i(uLoc.useWarp, 0);
        if (warps) {
          const [GX, GY] = warpGrid, data = new Uint8Array(GX * GY * MAX_LAYERS * 4).fill(127);
          warps.forEach((grid, k) => {
            for (let g = 0; g < GX * GY; g++) {
              const o = (k * GX * GY + g) * 4;
              data[o] = Math.max(0, Math.min(254, Math.round(grid[g * 2] / 0.2 * 254 + 127)));
              data[o + 1] = Math.max(0, Math.min(254, Math.round(grid[g * 2 + 1] / 0.2 * 254 + 127)));
              data[o + 3] = 255;
            }
          });
          warpTexture = gl.createTexture();
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, warpTexture);
          gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, GX, GY, MAX_LAYERS, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
          gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.activeTexture(gl.TEXTURE0);
          gl.uniform2f(uLoc.warpGrid, GX, GY);
          gl.uniform1i(uLoc.useWarp, 1);
        }
        const seamTextures = [];
        if (sessionStorage.getItem('seamRouting') !== '0') {
          try {
            const t0 = performance.now();
            const seams = computeSeamLabels(layers.slice(0, MAX_LAYERS), canvases, gains, tanHalfHF, tanHalfVF, { warps, warpGrid, misfit });
            const data = new Uint8Array(seams.width * seams.height * MAX_LAYERS);
            data.set(seams.masks.subarray(0, Math.min(seams.masks.length, data.length)));
            const t = gl.createTexture();
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, seams.width, seams.height, MAX_LAYERS, 0, gl.RED, gl.UNSIGNED_BYTE, data);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            seamTextures.push(t);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(uLoc.useLabels, 1);
            console.log(`Seam routing: ${seams.width}x${seams.height} owner map in ${(performance.now() - t0).toFixed(0)} ms`);
            this._stitchLog.push(`seams ${seams.width}x${seams.height} in ${(performance.now() - t0).toFixed(0)} ms`);
          } catch (e) {
            console.warn('Seam routing failed, using nearest-center seams:', e);
            gl.uniform1i(uLoc.useLabels, 0);
          }
        }

        // Seam cross-fade width in score units (~6 degrees at voronoiBias 1.5);
        // sessionStorage seamFeather='0' restores hard cuts.
        gl.uniform1f(uLoc.seamFeather, parseFloat(sessionStorage.getItem('seamFeather') ?? '0.06'));
        gl.uniform1f(uLoc.agreeLo, parseFloat(sessionStorage.getItem('agreeLo') ?? '0.08'));
        gl.uniform1f(uLoc.agreeHi, parseFloat(sessionStorage.getItem('agreeHi') ?? '0.35'));

        // Render
        gl.uniform1i(uLoc.refMode, 0);
        gl.viewport(0, 0, erpCanvas.width, erpCanvas.height);
        gl.clearColor(0, 0, 0, 1); // Clear to black
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // Small soft-averaged reference for the sky correction (same projection,
        // gains and roll). Optional: any failure leaves the stitch untouched.
        this._skyReference = null;
        if (parseFloat(sessionStorage.getItem('skyRefStrength') ?? '1') > 0) {
          try {
            this._skyReference = this._renderSkyReference(gl, uLoc.refMode, erpCanvas);
          } catch (e) {
            console.warn('Sky reference skipped:', e);
            this._skyReference = null;
          }
        }
      
        // Clean up
        gl.deleteTexture(tex);
        seamTextures.forEach((t) => gl.deleteTexture(t));
        if (warpTexture) gl.deleteTexture(warpTexture);
        gl.deleteProgram(prog);
        gl.deleteShader(vsShader);
        gl.deleteShader(fsShader);
        gl.deleteBuffer(vbo);
        gl.deleteVertexArray(vao);
      }
      

    // Post-stitch exposure equalization (homomorphic, GPU, 1 pass after mipmap)
    async postExposureEqualizeERP(erpCanvas, {
      strength = 0.85,    // 0..1 how strongly to flatten exposure
      kernelPx = 512,     // target blur scale (bigger = smoother)
      minGain = 0.6,
      maxGain = 1.6
    } = {}) {
      // Output canvas
      const out = document.createElement('canvas');
      out.width = erpCanvas.width;
      out.height = erpCanvas.height;

      const gl = out.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (!gl) {
        console.warn('WebGL2 not available; skipping exposure equalization');
        // Fallback: just draw original
        out.getContext('2d').drawImage(erpCanvas, 0, 0);
        return out;
      }

      // --- shaders ---
      const vs = `#version 300 es
      layout(location=0) in vec2 pos;
      out vec2 v_uv;
      void main(){ v_uv = 0.5*pos + 0.5; gl_Position = vec4(pos,0,1); }`;

      const fs = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      out vec4 frag;

      uniform sampler2D src;
      uniform float strength;
      uniform float lod;       // blur level
      uniform float lodMax;    // 1x1 mip level
      uniform float minGain;
      uniform float maxGain;

      vec3 toLin(vec3 c){ return pow(c, vec3(2.2)); }
      vec3 toSRGB(vec3 c){ return pow(max(c, vec3(0.0)), vec3(1.0/2.2)); }

      float luma(vec3 lin){ return max(1e-6, dot(lin, vec3(0.2126,0.7152,0.0722))); }

      void main(){
        // original (sRGB→linear)
        vec3 srgb = texture(src, v_uv).rgb;
        vec3 lin  = toLin(srgb);
        float logL = log(luma(lin));

        // low-frequency log-luminance via mipmaps
        // local smooth
        vec3 srgbLow = textureLod(src, v_uv, lod).rgb;
        float logSlow = log(luma(toLin(srgbLow)));

        // global mean (approx) from 1x1 mip
        vec3 srgbGlob = textureLod(src, v_uv, lodMax).rgb;
        float logSglob = log(luma(toLin(srgbGlob)));

        // correction in log-domain, clamped as gain
        float corr = -(logSlow - logSglob) * strength;
        float gain = clamp(exp(corr), minGain, maxGain);

        vec3 outLin = lin * gain;
        frag = vec4(toSRGB(outLin), 1.0);
      }`;

      // --- compile/link ---
      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(sh));
        }
        return sh;
      };
      const link = (vsSrc, fsSrc) => {
        const p = gl.createProgram();
        const v = compile(gl.VERTEX_SHADER, vsSrc);
        const f = compile(gl.FRAGMENT_SHADER, fsSrc);
        gl.attachShader(p, v); gl.attachShader(p, f);
        gl.bindAttribLocation(p, 0, 'pos');
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
          throw new Error(gl.getProgramInfoLog(p));
        }
        gl.deleteShader(v); gl.deleteShader(f);
        return p;
      };

      // --- fullscreen tri ---
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      // --- source texture from erpCanvas ---
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // sized internal format path (WebGL2). If some browsers complain, fallback below
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, erpCanvas);
      } catch(e) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, erpCanvas);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.generateMipmap(gl.TEXTURE_2D);

      const maxDim = Math.max(out.width, out.height);
      const lod = Math.max(0, Math.log2(maxDim / Math.max(1, kernelPx)));
      const lodMax = Math.floor(Math.log2(maxDim));

      // --- program & uniforms ---
      const prog = link(vs, fs);
      gl.useProgram(prog);
      const u = {
        src:        gl.getUniformLocation(prog, 'src'),
        strength:   gl.getUniformLocation(prog, 'strength'),
        lod:        gl.getUniformLocation(prog, 'lod'),
        lodMax:     gl.getUniformLocation(prog, 'lodMax'),
        minGain:    gl.getUniformLocation(prog, 'minGain'),
        maxGain:    gl.getUniformLocation(prog, 'maxGain'),
      };

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(u.src, 0);
      gl.uniform1f(u.strength, strength);
      gl.uniform1f(u.lod, lod);
      gl.uniform1f(u.lodMax, lodMax);
      gl.uniform1f(u.minGain, minGain);
      gl.uniform1f(u.maxGain, maxGain);

      // --- draw to 'out' canvas framebuffer (default) ---
      gl.viewport(0, 0, out.width, out.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // cleanup
      gl.deleteTexture(tex);
      gl.deleteBuffer(vbo);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog);

      return out;
    }

    /**
     * Apply multi-band blending to smooth seams
     * Simpler implementation: combine high frequencies from best-pixel with low frequencies from smooth blend
     */
    async applyMultiBandBlending(gl, erpCanvas, layers) {
        // Skip multi-band blending if disabled
        const disableMultiband = sessionStorage.getItem('disableMultibandBlending') === 'true';
        if (disableMultiband) {
            console.log('Multi-band blending disabled');
            return erpCanvas;
        }
        
        // Check if we have WebGL2 context
        if (!gl) {
            console.warn('No WebGL2 context for multi-band blending');
            return erpCanvas;
        }
        
        console.log('Applying simplified multi-band blending...');
        
        const width = erpCanvas.width;
        const height = erpCanvas.height;
        
        // Simple frequency-based blending shader
        const vs = `#version 300 es
        layout(location=0) in vec2 pos;
        out vec2 v_uv;
        void main(){ 
            v_uv = 0.5 * pos + 0.5; 
            gl_Position = vec4(pos, 0, 1); 
        }`;
        
        const fs = `#version 300 es
        precision highp float;
        in vec2 v_uv;
        out vec4 frag;
        
        uniform sampler2D original;  // Best-pixel result (sharp)
        uniform float blendStrength; // How much to blend (0-1)
        
        void main() {
            // Sample the original at different mipmap levels for frequency decomposition
            vec3 sharp = texture(original, v_uv).rgb;                    // Level 0: Full detail
            vec3 medium = textureLod(original, v_uv, 2.0).rgb;          // Level 2: Medium frequencies
            vec3 blurred = textureLod(original, v_uv, 4.0).rgb;         // Level 4: Low frequencies
            vec3 veryBlurred = textureLod(original, v_uv, 6.0).rgb;     // Level 6: Very low frequencies
            vec3 superBlurred = textureLod(original, v_uv, 8.0).rgb;    // Level 8: Super smooth
            
            // Detect sky regions (bright areas at top of image)
            float brightness = dot(sharp, vec3(0.299, 0.587, 0.114));
            float isSky = smoothstep(0.25, 0.45, v_uv.y) * smoothstep(0.4, 0.7, brightness);
            
            // Adaptive blending strength - much stronger for sky
            float adaptiveStrength = mix(blendStrength, min(1.0, blendStrength * 1.5), isSky);
            
            // Extract frequency bands
            vec3 highFreq = sharp - medium;              // Highest detail
            vec3 midFreq = medium - blurred;             // Medium detail
            vec3 lowFreq = blurred - veryBlurred;        // Low detail
            vec3 baseFreq = mix(veryBlurred, superBlurred, isSky);  // Use super smooth for sky
            
            // Reconstruct with progressive blending
            vec3 result = baseFreq;
            result += lowFreq * (1.0 - adaptiveStrength * 0.5);    // Blend low frequencies more
            result += midFreq * (1.0 - adaptiveStrength * 0.3);    // Blend mid frequencies
            result += highFreq * (1.0 - adaptiveStrength * 0.1);   // Even blend high freq slightly in sky
            
            // Ensure we don't lose too much contrast (less contrast boost for sky)
            float contrast = mix(1.05, 1.0, isSky);
            result = mix(vec3(0.5), result, contrast);
            
            frag = vec4(result, 1.0);
        }`;
        
        // Compile and link shader program
        const prog = this.compileProgram(gl, vs, fs);
        if (!prog) {
            console.warn('Failed to compile multi-band blending shader');
            return erpCanvas;
        }
        
        // Create texture from original with mipmaps for frequency decomposition
        const originalTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, originalTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, erpCanvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.generateMipmap(gl.TEXTURE_2D);
        
        // Setup rendering
        gl.useProgram(prog);
        
        // Create vertex buffer (full-screen triangle)
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        
        // Set uniforms
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, originalTex);
        gl.uniform1i(gl.getUniformLocation(prog, 'original'), 0);
        gl.uniform1f(gl.getUniformLocation(prog, 'blendStrength'), 0.85); // Increased for smoother sky blending
        
        // Create output canvas and render
        const outCanvas = document.createElement('canvas');
        outCanvas.width = width;
        outCanvas.height = height;
        const outCtx = outCanvas.getContext('2d');
        
        // Render to screen (we'll read it back)
        gl.viewport(0, 0, width, height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        
        // Read back result (no flip needed - the copy shader will handle it)
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        
        const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height);
        outCtx.putImageData(imageData, 0, 0);
        
        // Cleanup
        gl.deleteTexture(originalTex);
        gl.deleteProgram(prog);
        gl.deleteBuffer(vbo);
        gl.deleteVertexArray(vao);
        
        console.log('Simplified multi-band blending applied');
        return outCanvas;
    }
    
    /**
     * Helper to compile shader program
     */
    // Renders the sky reference (refMode 1) into a small offscreen buffer and
    // returns it upright (same row order as the final canvas).
    _renderSkyReference(gl, refModeLoc, erpCanvas) {
        const W = 512, H = 256;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        try {
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                throw new Error('reference framebuffer incomplete');
            }
            gl.viewport(0, 0, W, H);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.uniform1i(refModeLoc, 1);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            const raw = new Uint8Array(W * H * 4);
            gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
            // GL rows are bottom-up; flip exactly like the final readback does.
            const rgba = new Uint8ClampedArray(W * H * 4);
            for (let y = 0; y < H; y++) {
                rgba.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
            }
            return { width: W, height: H, rgba };
        } finally {
            gl.uniform1i(refModeLoc, 0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, erpCanvas.width, erpCanvas.height);
            gl.deleteFramebuffer(fb);
            gl.deleteTexture(tex);
        }
    }

    // Moves the panorama's broad tones (above ~1.4 degrees) toward the sky
    // reference: frame-to-frame exposure and white-balance steps (browser
    // cameras can't lock exposure) become smooth, while detail finer than that
    // stays as stitched. The sun and its bloom keep their own lightness.
    // Modifies finalCanvas (2D, upright) in place; throws on any failure so the
    // caller can keep the unmodified stitch.
    applySkyReference(finalCanvas, ref, strength = 1) {
        const W = ref.width, H = ref.height;
        const small = document.createElement('canvas');
        small.width = W; small.height = H;
        const sctx = small.getContext('2d', { willReadFrequently: true });
        sctx.imageSmoothingQuality = 'high';
        sctx.drawImage(finalCanvas, 0, 0, W, H);
        const cur = sctx.getImageData(0, 0, W, H).data;

        const lab = (r, g, b, out, i) => {
            const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
            const R = lin(r), G = lin(g), B = lin(b);
            const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
            const X = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
            const Y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
            const Z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
            out[i] = 116 * Y - 16; out[i + 1] = 500 * (X - Y); out[i + 2] = 200 * (Y - Z);
        };
        const N = W * H;
        const diff = new Float32Array(N * 3), weight = new Float32Array(N), light = new Float32Array(N);
        const a = new Float32Array(3), c = new Float32Array(3);
        for (let p = 0; p < N; p++) {
            const i = p * 4;
            lab(cur[i], cur[i + 1], cur[i + 2], c, 0);
            light[p] = c[0];
            if (ref.rgba[i + 3] < 250) continue;  // no frame covers this reference pixel
            lab(ref.rgba[i], ref.rgba[i + 1], ref.rgba[i + 2], a, 0);
            weight[p] = 1;
            diff[p * 3] = a[0] - c[0]; diff[p * 3 + 1] = a[1] - c[1]; diff[p * 3 + 2] = a[2] - c[2];
        }
        // Separable Gaussian, periodic in longitude, clamped at the poles. The
        // longitude kernel widens by 1/cos(latitude) so it covers the same
        // angle on the sphere at every row; a fixed width was a sliver near
        // the poles and drew spokes around the nadir fill and the zenith.
        const kernel = (sigma) => {
            const r = Math.min(W >> 1, Math.ceil(3 * sigma)), k = [];
            let sum = 0;
            for (let t = -r; t <= r; t++) { const v = Math.exp(-t * t / (2 * sigma * sigma)); k.push(v); sum += v; }
            for (let t = 0; t < k.length; t++) k[t] /= sum;
            return { r, k };
        };
        const blur = (src, ch, sigma) => {
            const { r, k } = kernel(sigma);
            const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
            for (let y = 0; y < H; y++) {
                const row = kernel(Math.min(W, sigma / Math.max(1e-3, Math.cos(Math.PI * (0.5 - (y + 0.5) / H)))));
                for (let x = 0; x < W; x++) for (let q = 0; q < ch; q++) {
                    let acc = 0;
                    for (let t = -row.r; t <= row.r; t++) acc += row.k[t + row.r] * src[((y * W) + ((x + t + 2 * W) % W)) * ch + q];
                    tmp[(y * W + x) * ch + q] = acc;
                }
            }
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let q = 0; q < ch; q++) {
                let acc = 0;
                for (let t = -r; t <= r; t++) acc += k[t + r] * tmp[(Math.min(H - 1, Math.max(0, y + t)) * W + x) * ch + q];
                out[(y * W + x) * ch + q] = acc;
            }
            return out;
        };
        const sigma = 2;  // 2 px of 512 = 1.4 degrees
        const diffB = blur(diff, 3, sigma), weightB = blur(weight, 1, sigma);
        // Sun and bloom (L* 82..92): keep the stitched lightness there.
        const hi = new Float32Array(N);
        for (let p = 0; p < N; p++) hi[p] = Math.min(1, Math.max(0, (light[p] - 82) / 10));
        const grown = new Float32Array(N);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            let m = 0;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
                const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = (x + dx + W) % W;
                m = Math.max(m, hi[yy * W + xx]);
            }
            grown[y * W + x] = m;
        }
        const hiB = blur(grown, 1, sigma);
        // Half-float storage preserves small Lab corrections and exact zero.
        // Byte packing quantized these to half a Lab unit and decoded zero as
        // +0.25, tinting even unchanged pixels and contouring smooth skies.
        const correction = new Float32Array(N * 4);
        for (let p = 0; p < N; p++) {
            const wb = weightB[p], fade = Math.min(1, wb * 2) * strength;
            const keepLight = 1 - Math.min(1, hiB[p]);
            for (let q = 0; q < 3; q++) {
                let d = wb > 1e-3 ? diffB[p * 3 + q] / wb * fade : 0;
                if (q === 0) d *= keepLight;
                correction[p * 4 + q] = Math.max(-63.5, Math.min(63.5, d));
            }
            correction[p * 4 + 3] = 1;
        }

        // Full-resolution apply pass on the GPU.
        const out = document.createElement('canvas');
        out.width = finalCanvas.width; out.height = finalCanvas.height;
        const gl = out.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
        if (!gl) throw new Error('WebGL2 unavailable for sky reference');
        const vs = `#version 300 es
        layout(location=0) in vec2 pos;
        out vec2 v_uv;
        void main(){ v_uv = 0.5*pos + 0.5; gl_Position = vec4(pos,0,1); }`;
        const fs = `#version 300 es
        precision highp float;
        in vec2 v_uv;
        out vec4 frag;
        uniform sampler2D src;
        uniform sampler2D corr;
        vec3 toLin(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
        vec3 toSRGB(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }
        float f(float t){ return t > 0.008856 ? pow(t, 1.0/3.0) : 7.787 * t + 16.0/116.0; }
        float fi(float t){ float t3 = t*t*t; return t3 > 0.008856 ? t3 : (t - 16.0/116.0) / 7.787; }
        void main(){
          vec4 px = texture(src, v_uv);
          vec3 l = toLin(px.rgb);
          float X = f(dot(l, vec3(0.4124, 0.3576, 0.1805)) / 0.95047);
          float Y = f(dot(l, vec3(0.2126, 0.7152, 0.0722)));
          float Z = f(dot(l, vec3(0.0193, 0.1192, 0.9505)) / 1.08883);
          vec3 lab = vec3(116.0*Y - 16.0, 500.0*(X - Y), 200.0*(Y - Z));
          lab += texture(corr, v_uv).rgb;
          float fy = (lab.x + 16.0) / 116.0;
          vec3 xyz = vec3(fi(fy + lab.y/500.0) * 0.95047, fi(fy), fi(fy - lab.z/200.0) * 1.08883);
          vec3 rgb = vec3(dot(xyz, vec3(3.2406, -1.5372, -0.4986)),
                          dot(xyz, vec3(-0.9689, 1.8758, 0.0415)),
                          dot(xyz, vec3(0.0557, -0.2040, 1.0570)));
          frag = vec4(toSRGB(rgb), px.a);
        }`;
        const prog = this.compileProgram(gl, vs, fs);
        if (!prog) throw new Error('sky reference shader failed to compile');
        const upload = (unit, source, w, h, data, wrapS) => {
            const t = gl.createTexture();
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            if (source) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, data);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        };
        const srcTex = upload(0, finalCanvas, 0, 0, null, gl.CLAMP_TO_EDGE);
        const corrTex = upload(1, null, W, H, correction, gl.REPEAT);  // wraps in longitude
        gl.useProgram(prog);
        gl.uniform1i(gl.getUniformLocation(prog, 'src'), 0);
        gl.uniform1i(gl.getUniformLocation(prog, 'corr'), 1);
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.viewport(0, 0, out.width, out.height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const fctx = finalCanvas.getContext('2d');
        fctx.drawImage(out, 0, 0);
        gl.deleteTexture(srcTex); gl.deleteTexture(corrTex);
        gl.deleteBuffer(vbo); gl.deleteVertexArray(vao); gl.deleteProgram(prog);
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
        out.width = 0; out.height = 0;
    }

    // Image-based alignment. Sensor poses place frames to within a few degrees;
    // this measures what overlapping frames actually show and corrects each
    // frame by a small rotation. Per overlapping pair: corners in frame i are
    // located in frame j by patch matching around the pose-predicted spot (the
    // patch is warped through the poses, so perspective doesn't fool it), a
    // deterministic RANSAC fits the small rotation that most far-field
    // correspondences agree on, and both directions of a pair must agree.
    // Then all frames are solved jointly with a pull toward the sensor pose,
    // dropping pairs that disagree (parallax), for a few focal scales, since
    // the nominal FOV is only approximate. Mutates layers' yaw/pitch/roll
    // (degrees). Returns { kept, residual, focalScale, summary }, or null if
    // nothing was applied. Everything is deterministic.
    computeImageAlignment(layers, canvases, tanHalfHF, tanHalfVF) {
        const n = Math.min(layers.length, 40);
        if (n < 3) return null;
        this._zenithDiagnostics = recoverZenithRoll(layers, canvases, tanHalfHF, tanHalfVF);
        for (const d of this._zenithDiagnostics) {
            const message = `Zenith ${d.hotspotId}: ${d.accepted ? 'recovered' : 'uncertain; kept original'} roll ${d.originalRoll.toFixed(1)} -> ${d.roll.toFixed(1)} deg, correlation ${d.score.toFixed(2)}, margin ${d.margin.toFixed(2)}, support ${d.support}`;
            console.log(message);
            this._stitchLog?.push(message);
        }
        const SW = 180, SH = 320, D = Math.PI / 180;
        // Rotation helpers in the stitch shader's convention: cam = Rroll*Rpitch*Ryaw*world.
        const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
        const cam = (y, p, r) => {
            const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r);
            return mul([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]], mul([[1, 0, 0], [0, cp, sp], [0, -sp, cp]], [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]));
        };
        const expRot = (w) => {
            const t = Math.hypot(w[0], w[1], w[2]);
            if (t < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
            const k = w.map((v) => v / t), c = Math.cos(t), s = Math.sin(t), v = 1 - c;
            return [[c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s],
                [k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s],
                [k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v]];
        };
        const decompose = (M) => {
            const r2 = M[2], pitch = Math.asin(Math.max(-1, Math.min(1, -r2[1]))), yaw = Math.atan2(-r2[0], r2[2]);
            const PY = mul(cam(0, pitch, 0), cam(yaw, 0, 0));
            const Rr = mul(M, [0, 1, 2].map((i) => [0, 1, 2].map((j) => PY[j][i])));
            return [yaw, pitch, Math.atan2(Rr[1][0], Rr[0][0])];
        };
        const apply = (M, d) => [M[0][0] * d[0] + M[0][1] * d[1] + M[0][2] * d[2], M[1][0] * d[0] + M[1][1] * d[1] + M[1][2] * d[2], M[2][0] * d[0] + M[2][1] * d[1] + M[2][2] * d[2]];
        const applyT = (M, d) => [M[0][0] * d[0] + M[1][0] * d[1] + M[2][0] * d[2], M[0][1] * d[0] + M[1][1] * d[1] + M[2][1] * d[2], M[0][2] * d[0] + M[1][2] * d[1] + M[2][2] * d[2]];
        const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return a.map((v) => v / l); };
        const pixelDir = (M, x, y) => norm(applyT(M, [((x + 0.5) / SW - 0.5) * 2 * tanHalfHF, ((y + 0.5) / SH - 0.5) * 2 * tanHalfVF, 1]));
        const dirPixel = (M, w) => {  // null if behind or outside the frame
            const c = apply(M, w);
            if (c[2] <= 0) return null;
            const xn = c[0] / c[2], yn = c[1] / c[2];
            if (Math.abs(xn) > tanHalfHF || Math.abs(yn) > tanHalfVF) return null;
            return [(xn / (2 * tanHalfHF) + 0.5) * SW - 0.5, (yn / (2 * tanHalfVF) + 0.5) * SH - 0.5];
        };

        // Small grayscale copies (level 0) and half-size copies (level 1).
        const gray = [], half = [], mats = [], HW = SW / 2, HH = SH / 2;
        // Bilinear sample with edge clamping.
        const sample = (img, W, H, x, y) => {
            x = Math.min(Math.max(x, 0), W - 1.001); y = Math.min(Math.max(y, 0), H - 1.001);
            const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, p = y0 * W + x0;
            return (img[p] * (1 - fx) + img[p + 1] * fx) * (1 - fy) + (img[p + W] * (1 - fx) + img[p + W + 1] * fx) * fy;
        };
        for (let i = 0; i < n; i++) {
            const d = boxDown(canvases[i], SW, SH), g = new Float32Array(SW * SH);
            for (let p = 0; p < SW * SH; p++) g[p] = 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2];
            const h = new Float32Array((SW / 2) * (SH / 2));
            for (let y = 0; y < SH / 2; y++) for (let x = 0; x < SW / 2; x++) {
                const p = 2 * y * SW + 2 * x;
                h[y * (SW / 2) + x] = 0.25 * (g[p] + g[p + 1] + g[p + SW] + g[p + SW + 1]);
            }
            gray.push(g); half.push(h);
            mats.push(cam(layers[i].yaw * D, layers[i].pitch * D, (layers[i].roll || 0) * D));
        }
        // Shi-Tomasi corners per frame, spread over a 6x10 bucket grid (deterministic order).
        const corners = gray.map((g) => {
            const ix = new Float32Array(SW * SH), iy = new Float32Array(SW * SH);
            for (let y = 1; y < SH - 1; y++) for (let x = 1; x < SW - 1; x++) {
                const p = y * SW + x;
                ix[p] = g[p - SW + 1] + 2 * g[p + 1] + g[p + SW + 1] - g[p - SW - 1] - 2 * g[p - 1] - g[p + SW - 1];
                iy[p] = g[p + SW - 1] + 2 * g[p + SW] + g[p + SW + 1] - g[p - SW - 1] - 2 * g[p - SW] - g[p - SW + 1];
            }
            // Structure tensor summed over 5x5 (separable box), then the smaller eigenvalue.
            const xx = new Float32Array(SW * SH), xy = new Float32Array(SW * SH), yy = new Float32Array(SW * SH);
            for (let y = 0; y < SH; y++) for (let x = 2; x < SW - 2; x++) {
                let a = 0, b = 0, c = 0;
                for (let dx = -2; dx <= 2; dx++) { const q = y * SW + x + dx; a += ix[q] * ix[q]; b += ix[q] * iy[q]; c += iy[q] * iy[q]; }
                const p = y * SW + x; xx[p] = a; xy[p] = b; yy[p] = c;
            }
            const resp = new Float32Array(SW * SH);
            for (let y = 3; y < SH - 3; y++) for (let x = 3; x < SW - 3; x++) {
                let a = 0, b = 0, c = 0;
                for (let dy = -2; dy <= 2; dy++) { const q = (y + dy) * SW + x; a += xx[q]; b += xy[q]; c += yy[q]; }
                resp[y * SW + x] = 0.5 * ((a + c) - Math.sqrt((a - c) * (a - c) + 4 * b * b));
            }
            const buckets = new Map(), BX = 6, BY = 10;
            for (let y = 6; y < SH - 6; y++) for (let x = 6; x < SW - 6; x++) {
                const p = y * SW + x, r = resp[p];
                if (r < 30000) continue;
                let peak = true;
                for (let dy = -2; dy <= 2 && peak; dy++) for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && resp[p + dy * SW + dx] >= r) { peak = false; break; }
                if (!peak) continue;
                const key = Math.floor(y * BY / SH) * BX + Math.floor(x * BX / SW);
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push([r, x, y]);
            }
            const out = [];
            for (const key of [...buckets.keys()].sort((u, v) => u - v)) { const list = buckets.get(key); list.sort((u, v) => v[0] - u[0]); for (const c of list.slice(0, 4)) out.push([c[1], c[2]]); }
            return out;
        });

        // Patch matching. A corner's 9x9 neighbourhood in frame i is projected
        // through both poses into frame j (so perspective is handled) and
        // normalized cross-correlation finds where it really sits: a coarse
        // search on the half-size images, then a fine bilinear search with a
        // parabolic sub-pixel peak.
        const R0 = 4, SIDE = 2 * R0 + 1, AREA = SIDE * SIDE, CENTER = (AREA - 1) / 2;
        const PAD = 18, PW = HW + 2 * PAD, PH = HH + 2 * PAD;
        // Half-size images with a replicated border: the coarse search needs no bounds checks.
        const halfPad = half.map((h) => {
            const p = new Float32Array(PW * PH);
            for (let y = 0; y < PH; y++) {
                const sy = Math.min(HH - 1, Math.max(0, y - PAD));
                for (let x = 0; x < PW; x++) p[y * PW + x] = h[sy * HW + Math.min(HW - 1, Math.max(0, x - PAD))];
            }
            return p;
        });
        const proj = new Float32Array(2 * AREA), base = new Int32Array(AREA), tmpl = new Float32Array(AREA), tmplH = new Float32Array(AREA);
        const coarse = new Float32Array(25 * 25), vals = new Float32Array(25);
        const maxSep = 2 * Math.atan(Math.max(tanHalfHF, tanHalfVF));
        const nccCoarse = (hp, off, tn) => {  // nearest, padded half image, offset in padded pixels
            let s = 0, ss = 0, st = 0;
            for (let k = 0; k < AREA; k++) { const v = hp[base[k] + off]; s += v; ss += v * v; st += v * tmplH[k]; }
            const varc = ss - s * s / AREA;
            return varc > 1e-6 ? st / Math.sqrt(varc) / tn : -1;
        };
        const nccFine = (img, dx, dy, tn) => {  // bilinear on the full small image
            let s = 0, ss = 0, st = 0;
            for (let k = 0; k < AREA; k++) { const v = sample(img, SW, SH, proj[2 * k] + dx, proj[2 * k + 1] + dy); s += v; ss += v * v; st += v * tmpl[k]; }
            const varc = ss - s * s / AREA;
            return varc > 1e-6 ? st / Math.sqrt(varc) / tn : -1;
        };
        // Small rotation w with d_i ~= d_j + w x d_j, i.e. -[d_j]x w = d_i - d_j.
        const solveW = (pairs, idx) => {
            const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
            for (const k of idx) {
                const [di, dj] = pairs[k];
                const rows = [[0, dj[2], -dj[1]], [-dj[2], 0, dj[0]], [dj[1], -dj[0], 0]];  // -[dj]x
                const rhs = [di[0] - dj[0], di[1] - dj[1], di[2] - dj[2]];
                for (let r = 0; r < 3; r++) {
                    for (let c = 0; c < 3; c++) for (let e = 0; e < 3; e++) A[r][c] += rows[e][r] * rows[e][c];
                    for (let e = 0; e < 3; e++) b[r] += rows[e][r] * rhs[e];
                }
            }
            for (let r = 0; r < 3; r++) A[r][r] += 1e-9;  // each pair is rank 2; together they span 3D
            const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
            if (Math.abs(det) < 1e-18) return null;
            const inv = [
                [(A[1][1] * A[2][2] - A[1][2] * A[2][1]) / det, (A[0][2] * A[2][1] - A[0][1] * A[2][2]) / det, (A[0][1] * A[1][2] - A[0][2] * A[1][1]) / det],
                [(A[1][2] * A[2][0] - A[1][0] * A[2][2]) / det, (A[0][0] * A[2][2] - A[0][2] * A[2][0]) / det, (A[0][2] * A[1][0] - A[0][0] * A[1][2]) / det],
                [(A[1][0] * A[2][1] - A[1][1] * A[2][0]) / det, (A[0][1] * A[2][0] - A[0][0] * A[2][1]) / det, (A[0][0] * A[1][1] - A[0][1] * A[1][0]) / det]];
            return apply(inv, b);
        };
        const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
        // Pixel correspondences [px, py, qx, qy]: frame i's corners found in frame j.
        const matchPair = (i, j) => {
            const gi = gray[i], gj = gray[j], hp = halfPad[j], found = [];
            // Consensus seed: the first corners search wide; once three agree on
            // the pair's bulk offset, the rest search a small window around it.
            // A pair that cannot seed in 20 tries has nothing reliable to offer.
            let wideTries = 0, seedX = 0, seedY = 0, seeded = false;
            const wide = [];
            for (const [px, py] of corners[i]) {
                if (found.length >= 40 || (!seeded && wideTries >= 20)) break;
                let ok = true, mean = 0, meanH = 0, k = 0;
                for (let dy = -R0; dy <= R0 && ok; dy++) for (let dx = -R0; dx <= R0; dx++, k++) {
                    const q = dirPixel(mats[j], pixelDir(mats[i], px + dx, py + dy));
                    if (!q) { ok = false; break; }
                    proj[2 * k] = q[0]; proj[2 * k + 1] = q[1];
                    base[k] = (Math.round(q[1] * 0.5) + PAD) * PW + Math.round(q[0] * 0.5) + PAD;
                    mean += tmpl[k] = gi[(py + dy) * SW + px + dx];
                    meanH += tmplH[k] = sample(half[i], HW, HH, (px + dx) * 0.5, (py + dy) * 0.5);
                }
                if (!ok) continue;
                let tvar = 0, hvar = 0;
                for (k = 0; k < AREA; k++) {
                    tmpl[k] -= mean / AREA; tvar += tmpl[k] * tmpl[k];
                    tmplH[k] -= meanH / AREA; hvar += tmplH[k] * tmplH[k];
                }
                if (tvar < 100 * AREA || hvar < 25 * AREA) continue;  // flat patch
                const tsd = Math.sqrt(tvar), tsdH = Math.sqrt(hvar);
                if (!seeded) wideTries++;
                // Coarse search on the half-size image: +-12 half px (+-6 degrees) unseeded.
                const RC = seeded ? 4 : 12, side = 2 * RC + 1;
                let best = -2, bx = 0, by = 0;
                for (let dy = -RC; dy <= RC; dy++) for (let dx = -RC; dx <= RC; dx++) {
                    const v = nccCoarse(hp, (seedY + dy) * PW + seedX + dx, tsdH);
                    coarse[(dy + RC) * side + dx + RC] = v;
                    if (v > best) { best = v; bx = seedX + dx; by = seedY + dy; }
                }
                if (best < 0.5) continue;
                if (!seeded) {
                    // A second peak away from the best means repetitive texture or an edge.
                    let second = -2;
                    for (let dy = -RC; dy <= RC; dy++) for (let dx = -RC; dx <= RC; dx++) {
                        if (Math.abs(seedX + dx - bx) <= 3 && Math.abs(seedY + dy - by) <= 3) continue;
                        second = Math.max(second, coarse[(dy + RC) * side + dx + RC]);
                    }
                    if (best - second < 0.05) continue;
                    wide.push([bx, by]);
                    if (wide.length >= 3) {
                        const xs = wide.map((o) => o[0]).sort((u, v) => u - v), ys = wide.map((o) => o[1]).sort((u, v) => u - v);
                        const mx = xs[xs.length >> 1], my = ys[ys.length >> 1];
                        if (wide.filter((o) => Math.abs(o[0] - mx) <= 2 && Math.abs(o[1] - my) <= 2).length >= 3) { seedX = mx; seedY = my; seeded = true; }
                    }
                }
                // Fine search on the full small image around 2x the coarse offset, then sub-pixel.
                let fbest = -2, fx = 2 * bx, fy = 2 * by;
                for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
                    const v = nccFine(gj, 2 * bx + dx, 2 * by + dy, tsd);
                    vals[(dy + 2) * 5 + dx + 2] = v;
                    if (v > fbest) { fbest = v; fx = 2 * bx + dx; fy = 2 * by + dy; }
                }
                if (fbest < 0.55) continue;
                const cx = fx - 2 * bx + 2, cy = fy - 2 * by + 2;
                let sx = 0, sy = 0;
                if (cx > 0 && cx < 4 && cy > 0 && cy < 4) {
                    const l = vals[cy * 5 + cx - 1], r = vals[cy * 5 + cx + 1], u = vals[(cy - 1) * 5 + cx], d = vals[(cy + 1) * 5 + cx];
                    const den1 = l - 2 * fbest + r, den2 = u - 2 * fbest + d;
                    if (den1 < -1e-6) sx = Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / den1));
                    if (den2 < -1e-6) sy = Math.max(-0.5, Math.min(0.5, 0.5 * (u - d) / den2));
                }
                found.push([px, py, proj[2 * CENTER] + fx + sx, proj[2 * CENTER + 1] + fy + sy]);
            }
            return found;
        };
        const matches = new Map();  // ordered pair -> pixel correspondences
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            if (i === j || angle(mats[i][2], mats[j][2]) > maxSep) continue;
            const found = matchPair(i, j);
            if (found.length >= 5) matches.set(i * n + j, found);
        }
        if (!matches.size) return null;

        // Gaussian elimination with partial pivoting; A (rows of Float64Array) and b are consumed.
        const solveDense = (A, b) => {
            const N = b.length;
            for (let c = 0; c < N; c++) {
                let piv = c;
                for (let r = c + 1; r < N; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
                [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
                for (let r = c + 1; r < N; r++) {
                    const f = A[r][c] / A[c][c];
                    if (!f) continue;
                    for (let q = c; q < N; q++) A[r][q] -= f * A[c][q];
                    b[r] -= f * b[c];
                }
            }
            const x = new Float64Array(N);
            for (let r = N - 1; r >= 0; r--) {
                let s = b[r];
                for (let q = r + 1; q < N; q++) s -= A[r][q] * x[q];
                x[r] = s / A[r][r];
            }
            return x;
        };
        // Global least squares: per-frame world rotations x with x_j - x_i = w_ij,
        // a weak prior toward the sensor pose, and a weaker pull between
        // neighbouring frames so a frame without matches (sky, bare ground)
        // follows the frames around it rather than staying on its sensor pose.
        const neighbours = [];
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (angle(mats[i][2], mats[j][2]) < 50 * D) neighbours.push([i, j]);
        const solve = (edges) => {
            const N = 3 * n, A = Array.from({ length: N }, () => new Float64Array(N)), b = new Float64Array(N);
            const mean = edges.reduce((s, e) => s + e.weight, 0) / Math.max(1, edges.length), lambda = 0.02 * mean, smooth = 0.01 * mean;
            for (let k = 0; k < N; k++) A[k][k] += lambda;
            for (const [i, j] of neighbours) for (let c = 0; c < 3; c++) {
                const jj = 3 * j + c, ii = 3 * i + c;
                A[jj][jj] += smooth; A[ii][ii] += smooth; A[jj][ii] -= smooth; A[ii][jj] -= smooth;
            }
            for (const e of edges) for (let c = 0; c < 3; c++) {
                const jj = 3 * e.j + c, ii = 3 * e.i + c;
                A[jj][jj] += e.weight; A[ii][ii] += e.weight; A[jj][ii] -= e.weight; A[ii][jj] -= e.weight;
                b[jj] += e.weight * e.w[c]; b[ii] -= e.weight * e.w[c];
            }
            return solveDense(A, b);
        };
        const residual = (x, e) => Math.hypot(...[0, 1, 2].map((c) => x[3 * e.j + c] - x[3 * e.i + c] - e.w[c]));

        // From here on everything is cheap, so it runs for several focal
        // scales: the camera FOV is nominal, and a few percent off shows up as
        // pair rotations that no set of frame poses can satisfy together.
        const estimate = (focal) => {
            const dir = (M, x, y) => norm(applyT(M, [((x + 0.5) / SW - 0.5) * 2 * tanHalfHF * focal, ((y + 0.5) / SH - 0.5) * 2 * tanHalfVF * focal, 1]));
            // Per ordered pair: the rotation w that moves j's directions onto
            // i's, by deterministic RANSAC (64 two-point samples from a fixed
            // linear congruential sequence) so a wrong depth layer cannot vote.
            const ransac = (pairs, gate) => {
                const err = (w, k) => angle(pairs[k][0], apply(expRot(w), pairs[k][1]));
                let seed = 12345, bestInliers = [];
                const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed; };
                for (let it = 0; it < 64; it++) {
                    const a = rnd() % pairs.length, b = rnd() % pairs.length;
                    if (a === b) continue;
                    const w = solveW(pairs, [a, b]);
                    if (!w || Math.hypot(w[0], w[1], w[2]) > 6 * D) continue;
                    const inl = [];
                    for (let k = 0; k < pairs.length; k++) if (err(w, k) < gate) inl.push(k);
                    if (inl.length > bestInliers.length) bestInliers = inl;
                }
                if (bestInliers.length < 5) return null;
                let w = solveW(pairs, bestInliers);
                if (!w) return null;
                const inl = [];
                for (let k = 0; k < pairs.length; k++) if (err(w, k) < gate) inl.push(k);
                if (inl.length >= 5) w = solveW(pairs, inl) || w;
                return { w, n: inl.length };
            };
            const measured = new Map();
            for (const [key, found] of matches) {
                const i = Math.floor(key / n), j = key % n, far = [], all = [];
                for (const [px, py, qx, qy] of found) {
                    const pair = [dir(mats[i], px, py), dir(mats[j], qx, qy)];
                    all.push(pair);
                    // Far content constrains a rotation; ground below the horizon
                    // (world y is down) sits metres away and shows parallax.
                    if (pair[0][1] <= Math.sin(3 * D)) far.push(pair);
                }
                let m = far.length >= 5 ? ransac(far, 0.35 * D) : null;
                if (m) m.ground = false;
                else if (all.length >= 5) {
                    // Ground-only pairs (the lower ring) still get a looser fit, so
                    // the ground lines up at those seams instead of staying on the
                    // sensor pose while the frames above move.
                    m = ransac(all, 0.6 * D);
                    if (m) m.ground = true;
                }
                if (m) measured.set(key, m);
            }
            // Both directions of a pair come from their own corners and must
            // agree (w_ji ~= -w_ij); that catches a wrong RANSAC consensus.
            const meas = [];
            for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
                const a = measured.get(i * n + j), b = measured.get(j * n + i);
                if (!a || !b || Math.hypot(a.w[0] + b.w[0], a.w[1] + b.w[1], a.w[2] + b.w[2]) > 0.75 * D) continue;
                const ground = a.ground || b.ground;
                meas.push({ i, j, ground, w: [0, 1, 2].map((c) => 0.5 * (a.w[c] - b.w[c])), n: a.n + b.n, weight: (ground ? 0.5 : 1) * Math.sqrt(a.n + b.n) });
            }
            if (meas.filter((e) => !e.ground).length < 3) return null;
            // Pairs that disagree with the consensus (parallax) are dropped over a few rounds.
            let x = solve(meas), kept = meas;
            for (let round = 0; round < 3; round++) {
                const sorted = kept.map((e) => residual(x, e)).sort((a, b) => a - b);
                const cut = Math.max(0.6 * D, 3 * sorted[sorted.length >> 1]);
                const next = kept.filter((e) => residual(x, e) < cut);
                if (next.length === kept.length || next.length < 3) break;
                kept = next; x = solve(kept);
            }
            const far = meas.filter((e) => !e.ground);
            const score = far.reduce((s, e) => s + e.weight * Math.min(residual(x, e), D), 0) / far.reduce((s, e) => s + e.weight, 0);
            return { x, meas, kept, score };
        };
        // Which pairs get dropped changes from scale to scale, so the score is
        // jagged; the pick is the minimum of a 3-point moving average.
        const scales = [], results = [];
        for (let k = -3; k <= 6; k++) { scales.push(1 + 0.02 * k); results.push(estimate(1 + 0.02 * k)); }  // 0.94 .. 1.12
        let best = null, focal = 1;
        for (let k = 0; k < scales.length; k++) {
            const near = results.slice(Math.max(0, k - 1), k + 2);
            if (!results[k] || near.some((e) => !e)) continue;
            const score = near.reduce((s, e) => s + e.score, 0) / near.length;
            if (!best || score < best.score) { best = { ...results[k], score }; focal = scales[k]; }
        }
        if (!best) return null;
        const { x, meas, kept } = best;
        const before = meas.reduce((s, e) => s + Math.hypot(...e.w), 0) / meas.length / D;
        const after = kept.reduce((s, e) => s + residual(x, e), 0) / Math.max(1, kept.length) / D;
        // Apply (capped at 5 degrees per frame).
        let maxCorr = 0;
        const finalMats = [];
        for (let k = 0; k < n; k++) {
            let w = [x[3 * k], x[3 * k + 1], x[3 * k + 2]];
            const mag = Math.hypot(w[0], w[1], w[2]);
            if (mag > 5 * D) w = w.map((v) => v * 5 * D / mag);
            maxCorr = Math.max(maxCorr, Math.min(mag, 5 * D));
            finalMats.push(mul(mats[k], expRot(w.map((v) => -v))));
            const [y, p, r] = decompose(finalMats[k]);
            layers[k].yaw = y / D; layers[k].pitch = p / D; layers[k].roll = r / D;
        }

        // Local warps for what a rotation cannot fix: near ground shows
        // parallax (metres away, camera off its rotation axis), so at those
        // seams the frames still disagree by degrees. Each frame gets a smooth
        // displacement grid D (fractions of the frame, forward: where a source
        // pixel should appear) that moves its matches half way to the other
        // frame's; the render and the seam finder sample a frame at (u,v) - D(u,v).
        const GX = 9, GY = 16, NG = GX * GY, tH = tanHalfHF * focal, tV = tanHalfVF * focal;
        const dirF = (M, px, py) => norm(applyT(M, [((px + 0.5) / SW - 0.5) * 2 * tH, ((py + 0.5) / SH - 0.5) * 2 * tV, 1]));
        const pixF = (M, w) => { const c = apply(M, w); return c[2] > 0 ? [(c[0] / c[2] / (2 * tH) + 0.5) * SW - 0.5, (c[1] / c[2] / (2 * tV) + 0.5) * SH - 0.5] : null; };
        const obs = Array.from({ length: n }, () => []);  // per frame: [u, v, du, dv]
        let parallax = 0, nObs = 0;
        for (const [key, found] of matches) {
            const i = Math.floor(key / n), j = key % n;
            for (const [px, py, qx, qy] of found) {
                const di = dirF(finalMats[i], px, py), dj = dirF(finalMats[j], qx, qy), r = angle(di, dj);
                if (r > 6 * D) continue;  // a wrong match, not parallax
                const m = norm([di[0] + dj[0], di[1] + dj[1], di[2] + dj[2]]);
                const ti = pixF(finalMats[i], m), tj = pixF(finalMats[j], m);
                if (!ti || !tj) continue;
                obs[i].push([(px + 0.5) / SW, (py + 0.5) / SH, (ti[0] - px) / SW, (ti[1] - py) / SH]);
                obs[j].push([(qx + 0.5) / SW, (qy + 0.5) / SH, (tj[0] - qx) / SW, (tj[1] - qy) / SH]);
                parallax += r; nObs++;
            }
        }
        // Per frame: least squares on the node grid with bilinear weights, a
        // smoothness term between neighbouring nodes and a weak pull to zero
        // (unobserved regions stay put); a second round down-weights matches
        // the smooth grid cannot follow, so a wrong match cannot bend it.
        const nodesAt = (u, v) => {
            const gx = Math.min(GX - 1.001, Math.max(0, u * (GX - 1))), gy = Math.min(GY - 1.001, Math.max(0, v * (GY - 1)));
            const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0, g = y0 * GX + x0;
            return [[g, (1 - fx) * (1 - fy)], [g + 1, fx * (1 - fy)], [g + GX, (1 - fx) * fy], [g + GX + 1, fx * fy]];
        };
        const warps = [];
        let fitErr = 0, fitN = 0;
        // Measured misalignment after the warps, on the seam finder's grid:
        // the seam width can then follow what the data shows instead of a
        // rule of thumb about elevation (indoors a ceiling is close).
        const MW = 512, MH = 256, misfitSum = new Float32Array(MW * MH), misfitN = new Float32Array(MW * MH);
        const hDeg = 2 * Math.atan(tH) / D, vDeg = 2 * Math.atan(tV) / D;
        for (let k = 0; k < n; k++) {
            const grid = new Float32Array(NG * 2), o = obs[k], weights = new Float32Array(o.length).fill(1);
            warps.push(grid);
            if (o.length < 4) continue;
            for (let round = 0; round < 2; round++) {
                const A = Array.from({ length: NG }, () => new Float64Array(NG)), bx = new Float64Array(NG), by = new Float64Array(NG);
                for (let g = 0; g < NG; g++) {
                    A[g][g] += 0.01;
                    for (const h of [g % GX + 1 < GX ? g + 1 : -1, g + GX < NG ? g + GX : -1]) {
                        if (h < 0) continue;
                        A[g][g] += 0.2; A[h][h] += 0.2; A[g][h] -= 0.2; A[h][g] -= 0.2;
                    }
                }
                o.forEach(([u, v, du, dv], idx) => {
                    const w = weights[idx], nn = nodesAt(u, v);
                    for (const [a, wa] of nn) {
                        for (const [b, wb] of nn) A[a][b] += w * wa * wb;
                        bx[a] += w * wa * du; by[a] += w * wa * dv;
                    }
                });
                const sx = solveDense(A.map((row) => Float64Array.from(row)), bx), sy = solveDense(A, by);
                for (let g = 0; g < NG; g++) { grid[g * 2] = sx[g]; grid[g * 2 + 1] = sy[g]; }
                o.forEach(([u, v, du, dv], idx) => {
                    let ex = -du, ey = -dv;
                    for (const [a, wa] of nodesAt(u, v)) { ex += wa * grid[a * 2]; ey += wa * grid[a * 2 + 1]; }
                    const e = Math.hypot(ex, ey);
                    weights[idx] = e > 0.004 ? 0.004 / e : 1;  // ~3 px of 720
                    if (round === 1) {
                        fitErr += e; fitN++;
                        const dw = dirF(finalMats[k], u * SW - 0.5, v * SH - 0.5);
                        const lat = Math.asin(Math.max(-1, Math.min(1, dw[1]))), lon = Math.atan2(dw[0], dw[2]);
                        const cell = Math.min(MH - 1, Math.max(0, Math.round((0.5 - lat / Math.PI) * MH - 0.5))) * MW + (Math.round((lon + Math.PI) / (2 * Math.PI) * MW - 0.5) + MW) % MW;
                        misfitSum[cell] += Math.hypot(ex * hDeg, ey * vDeg); misfitN[cell]++;
                    }
                });
            }
        }
        // Cells without a match take the mean of measured cells within 5; the rest stay NaN.
        const misfit = new Float32Array(MW * MH).fill(NaN);
        for (let r = 0; r < MH; r++) for (let c = 0; c < MW; c++) {
            let s = 0, cnt = 0;
            for (let dy = -5; dy <= 5; dy++) {
                const rr = r + dy;
                if (rr < 0 || rr >= MH) continue;
                for (let dx = -5; dx <= 5; dx++) { const q = rr * MW + (c + dx + MW) % MW; s += misfitSum[q]; cnt += misfitN[q]; }
            }
            if (cnt) misfit[r * MW + c] = s / cnt;
        }
        const inliers = kept.reduce((s, e) => s + e.n, 0);
        return {
            kept: kept.length, residual: after, focalScale: focal, warps, warpGrid: [GX, GY], misfit: { width: MW, height: MH, data: misfit },
            summary: `${kept.length}/${meas.length} pairs (${inliers} inlier matches), focal x${focal.toFixed(2)}, mean misfit ${before.toFixed(2)} -> ${after.toFixed(2)} deg, max correction ${(maxCorr / D).toFixed(2)} deg; warp ${nObs} matches, parallax ${nObs ? (parallax / nObs / D).toFixed(2) : '0'} deg, fit ${fitN ? (fitErr / fitN * 720).toFixed(1) : '0'} px`,
        };
    }

    compileProgram(gl, vsSrc, fsSrc) {
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vsSrc);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
            console.error('VS error:', gl.getShaderInfoLog(vs));
            return null;
        }
        
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fsSrc);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
            console.error('FS error:', gl.getShaderInfoLog(fs));
            return null;
        }
        
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error('Link error:', gl.getProgramInfoLog(prog));
            return null;
        }
        
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return prog;
    }

    _erpCenterFromYawPitch(yawDeg, pitchDeg){
        const yaw = yawDeg * Math.PI/180;
        const pitch = pitchDeg * Math.PI/180;
        // camera forward direction in world:
        // (sin yaw * cos pitch, sin pitch, cos yaw * cos pitch)
        const x = Math.sin(yaw) * Math.cos(pitch);
        const y = Math.sin(pitch);
        const z = Math.cos(yaw) * Math.cos(pitch);
        const lon = Math.atan2(x, z);      // -pi..pi
        const lat = Math.asin(y);          // -pi/2..pi/2
        const u = (lon + Math.PI) / (2*Math.PI); // 0..1
        const v = 0.5 - (lat / Math.PI);         // 0..1
        return [u, v];
    }
    
    /**
     * Clean up WebGL resources and stitching memory
     * Called when opening camera roll from processor card
     */
    cleanupStitchingMemory() {
        console.log('Cleaning up stitching memory');

        // The stitched 4096x2048 canvas, kept for the processor card's View button
        if (this.lastStitchedPanorama) {
            this.lastStitchedPanorama.width = this.lastStitchedPanorama.height = 1;
            this.lastStitchedPanorama = null;
        }
        const viewBtn = document.getElementById('view-btn');
        if (viewBtn) viewBtn.onclick = null;
        
        // Clean up stitched canvas
        if (this.stitchedCanvas) {
            const ctx = this.stitchedCanvas.getContext('2d');
            if (ctx) {
                ctx.clearRect(0, 0, this.stitchedCanvas.width, this.stitchedCanvas.height);
            }
            this.stitchedCanvas.width = 1;
            this.stitchedCanvas.height = 1;
            this.stitchedCanvas = null;
        }
        
        // Clean up WebGL context
        if (this.gl) {
            // Lose the context to free GPU resources
            const loseContext = this.gl.getExtension('WEBGL_lose_context');
            if (loseContext) {
                loseContext.loseContext();
            }
            this.gl = null;
        }
        
        // Clear any temporary canvases
        if (this.tempCanvas) {
            this.tempCanvas.width = 1;
            this.tempCanvas.height = 1;
            this.tempCanvas = null;
        }
        
        // Run garbage collection hint (may not actually trigger GC)
        // Note: window.gc only exists in Chrome with --js-flags="--expose-gc"
        if (typeof window !== 'undefined' && window.gc) {
            window.gc();
        }
    }
      
    animate() {
        requestAnimationFrame(() => this.animate());
        
        if (this.scene) {
            this.scene.render();
        }
    }
    
    /**
     * Lock the processing card UI to prevent user from leaving
     */
    lockProcessingCard() {
        this.elements.stitchingOverlay.classList.add('is-processing');
        this.elements.stitchingOverlay.classList.remove('is-complete', 'is-failed');
        // Find and hide the close button on overlay
        const overlayCloseBtn = this.elements.stitchingOverlay.querySelector('.close-btn');
        if (overlayCloseBtn) {
            overlayCloseBtn.style.display = 'none';
        }
        
        // Disable all buttons in processor card
        const processorCard = document.getElementById('processor-card');
        if (processorCard) {
            // Disable close button
            const cardCloseBtn = processorCard.querySelector('.card-close-btn');
            if (cardCloseBtn) {
                cardCloseBtn.disabled = true;
                cardCloseBtn.style.opacity = '0.3';
                cardCloseBtn.style.cursor = 'not-allowed';
            }
            
            // Disable action buttons (view, share, camera roll, start new)
            const actionButtons = processorCard.querySelectorAll('#processor-actions button');
            actionButtons.forEach(btn => {
                btn.disabled = true;
                btn.style.opacity = '0.3';
                btn.style.cursor = 'not-allowed';
            });
        }
        
        // Cancel button removed - stitching is fast enough that canceling isn't needed
        // Prevent page navigation
        this.beforeUnloadHandler = (e) => {
            e.preventDefault();
            e.returnValue = 'Processing in progress. Are you sure you want to leave?';
            return 'Processing in progress. Are you sure you want to leave?';
        };
        window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }
    
    /**
     * Unlock the processing card UI after processing
     */
    unlockProcessingCard() {
        this.elements.stitchingOverlay.classList.remove('is-processing');
        // Restore close button on overlay
        const overlayCloseBtn = this.elements.stitchingOverlay.querySelector('.close-btn');
        if (overlayCloseBtn) {
            overlayCloseBtn.style.display = '';
        }
        
        // Re-enable all buttons in processor card
        const processorCard = document.getElementById('processor-card');
        if (processorCard) {
            // Re-enable close button
            const cardCloseBtn = processorCard.querySelector('.card-close-btn');
            if (cardCloseBtn) {
                cardCloseBtn.disabled = false;
                cardCloseBtn.style.opacity = '';
                cardCloseBtn.style.cursor = '';
            }
            
            // Re-enable action buttons
            const actionButtons = processorCard.querySelectorAll('#processor-actions button');
            actionButtons.forEach(btn => {
                btn.disabled = false;
                btn.style.opacity = '';
                btn.style.cursor = '';
            });
        }
        
        // Cancel button has been removed - no longer needed
        
        // Remove navigation prevention
        if (this.beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this.beforeUnloadHandler);
            this.beforeUnloadHandler = null;
        }
    }
    
    // Cancel processing method removed - stitching is fast enough that canceling isn't needed
}
