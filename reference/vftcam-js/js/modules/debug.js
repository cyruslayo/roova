// Debug utilities for testing without capturing
export class Debug {
    constructor(database) {
        this.database = database;
        this.enabled = false;
    }

    enable(showUI = true) {
        this.enabled = true;
        console.log('Debug mode enabled');
        if (showUI) {
            this.addDebugUI();
        }
    }

    addDebugUI() {
        const debugPanel = document.createElement('div');
        debugPanel.id = 'debug-panel';
        debugPanel.innerHTML = `
            <div style="position: fixed; top: calc(env(safe-area-inset-top, 0px) + 50px); left: 10px; background: rgba(0,0,0,0.8); 
                        color: white; padding: 10px; border-radius: 5px; font-family: monospace;
                        font-size: 12px; z-index: 10000; min-width: 200px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                    <h3 style="margin: 0;">Debug Tools</h3>
                    <button id="debug-toggle" style="background: none; border: none; color: white; 
                                                     font-size: 16px; cursor: pointer; padding: 0 5px;
                                                     transition: transform 0.2s;">
                        ▼
                    </button>
                </div>
                <div id="debug-buttons" style="display: block; overflow: hidden; transition: all 0.3s ease;">
                    <button id="debug-load-sample" class="debug-btn">
                        Load Sample Images (36)
                    </button>
                    <button id="debug-toggle-gain" class="debug-btn toggle-on">
                        Gain Compensation: ON
                    </button>
                    <button id="debug-toggle-vignette" class="debug-btn toggle-on">
                        Vignette Correction: 0.8
                    </button>                    
                    <button id="debug-test-stitch" class="debug-btn primary">
                        Test Stitching
                    </button>
                    <button id="debug-simulate-interrupt" class="debug-btn danger">
                        Simulate Interrupted Stitch
                    </button>
                    <button id="debug-clear" class="debug-btn">
                        Clear All Data
                    </button>
                    <button id="debug-export" class="debug-btn">
                        Export Images (ZIP)
                    </button>                    
                </div>
                <hr style="margin: 10px 0;">
                <div id="debug-info">Ready</div>
            </div>
        `;
        document.body.appendChild(debugPanel);

        // Add collapse/expand functionality
        const toggleBtn = document.getElementById('debug-toggle');
        const buttonsDiv = document.getElementById('debug-buttons');
        let isCollapsed = localStorage.getItem('debugPanelCollapsed') === 'true';
        
        // Apply initial collapsed state
        if (isCollapsed) {
            buttonsDiv.style.display = 'none';
            toggleBtn.textContent = '▲';
        }
        
        toggleBtn.addEventListener('click', () => {
            isCollapsed = !isCollapsed;
            if (isCollapsed) {
                buttonsDiv.style.display = 'none';
                toggleBtn.textContent = '▲';
            } else {
                buttonsDiv.style.display = 'block';
                toggleBtn.textContent = '▼';
            }
            // Save preference
            localStorage.setItem('debugPanelCollapsed', isCollapsed.toString());
        });

        // Add event listeners for buttons
        document.getElementById('debug-load-sample').addEventListener('click', () => this.loadSampleImages());
        document.getElementById('debug-test-stitch').addEventListener('click', () => this.testStitching());
        document.getElementById('debug-clear').addEventListener('click', () => this.clearAllData());
        document.getElementById('debug-export').addEventListener('click', () => this.exportImages());
        document.getElementById('debug-simulate-interrupt').addEventListener('click', () => this.simulateInterruptedStitch());
        
        // Gain compensation toggle
        const gainBtn = document.getElementById('debug-toggle-gain');
        const gainEnabled = sessionStorage.getItem('disableGainCompensation') !== 'true';
        gainBtn.textContent = `Gain Compensation: ${gainEnabled ? 'ON' : 'OFF'}`;
        gainBtn.classList.remove('toggle-on', 'toggle-off');
        gainBtn.classList.add(gainEnabled ? 'toggle-on' : 'toggle-off');
        
        gainBtn.addEventListener('click', () => {
            const currentState = sessionStorage.getItem('disableGainCompensation') !== 'true';
            const newState = !currentState;
            sessionStorage.setItem('disableGainCompensation', newState ? 'false' : 'true');
            gainBtn.textContent = `Gain Compensation: ${newState ? 'ON' : 'OFF'}`;
            gainBtn.classList.remove('toggle-on', 'toggle-off');
            gainBtn.classList.add(newState ? 'toggle-on' : 'toggle-off');
            this.updateDebugInfo(`Gain compensation ${newState ? 'enabled' : 'disabled'}`);
        });
                
        // Vignetting correction slider
        const vignetteBtn = document.getElementById('debug-toggle-vignette');
        const currentVignette = parseFloat(sessionStorage.getItem('vignetteCorrection') || '1');
        vignetteBtn.textContent = `Vignette Correction: ${currentVignette.toFixed(1)}`;
        vignetteBtn.classList.remove('toggle-on', 'toggle-off');
        vignetteBtn.classList.add(currentVignette > 0 ? 'toggle-on' : 'toggle-off');
        
        vignetteBtn.addEventListener('click', () => {
            // Cycle through multiples of the measured lens falloff: 0, 0.5, 1, 1.5
            const current = parseFloat(sessionStorage.getItem('vignetteCorrection') || '1');
            let newValue;
            if (current === 0) newValue = 0.5;
            else if (current === 0.5) newValue = 1;
            else if (current === 1) newValue = 1.5;
            else newValue = 0.0;
            
            sessionStorage.setItem('vignetteCorrection', newValue.toString());
            vignetteBtn.textContent = `Vignette Correction: ${newValue.toFixed(1)}`;
            vignetteBtn.classList.remove('toggle-on', 'toggle-off');
            vignetteBtn.classList.add(newValue > 0 ? 'toggle-on' : 'toggle-off');
            this.updateDebugInfo(`Vignette correction set to ${newValue.toFixed(1)}`);
        });
    }

    async loadSampleImages() {
        console.log('Loading sample images from /sample-images...');
        const infoDiv = document.getElementById('debug-info');
        infoDiv.textContent = 'Loading...';
        
        try {
            // Clear existing data first - with error handling
            try {
                await this.database.clearAllImages();
            } catch (clearError) {
                console.warn('Could not clear images, continuing anyway:', clearError);
                // Try to continue anyway
            }
            
            let loadedCount = 0;
            const totalImages = 36;
            
            // Load all 36 images
            for (let i = 1; i <= 36; i++) {
                const paddedId = String(i).padStart(2, '0');
                
                // Determine pitch and yaw from hotspot ID
                let pitch, yaw;
                if (i <= 12) {
                    // Upper ring (pitch +45)
                    pitch = 45;
                    yaw = (i - 1) * 30;
                } else if (i <= 24) {
                    // Middle ring (pitch 0)
                    pitch = 0;
                    yaw = (i - 13) * 30;
                } else {
                    // Lower ring (pitch -45)
                    pitch = -45;
                    yaw = (i - 25) * 30;
                }
                
                // Build the correct filename based on the actual format in sample-images
                // Try AVIF first, then fall back to JPEG
                const avifFilename = `hotspot_${paddedId}_p${pitch}_y${yaw}.avif`;
                const jpgFilename = `hotspot_${paddedId}_p${pitch}_y${yaw}.jpg`;
                const avifUrl = `./sample-images/${avifFilename}`;
                const jpgUrl = `./sample-images/${jpgFilename}`;
                
                let filename = avifFilename;  // Define filename in outer scope
                
                try {
                    // Try AVIF first
                    let response = await fetch(avifUrl);
                    
                    if (!response.ok) {
                        // Fall back to JPEG
                        response = await fetch(jpgUrl);
                        filename = jpgFilename;
                        if (!response.ok) {
                            console.error(`Failed to load ${avifUrl} or ${jpgUrl}: ${response.status}`);
                            continue;
                        }
                    }
                    
                    const blob = await response.blob();
                    
                    // Calculate FOV based on pitch (same as in Hotspots.calculateFOV)
                    const fov = pitch === 0 ? 67 : 
                               Math.abs(pitch) === 45 ? 54 : 67;
                    
                    // Store in database with blob (new format)
                    // NOTE: actualPitch and actualYaw should be in DEGREES, not radians!
                    await this.database.saveImage({
                        imageBlob: blob,       // Save blob directly
                        hotspotId: i,
                        pitch: pitch,          // Ideal pitch in degrees
                        yaw: yaw,              // Ideal yaw in degrees
                        actualPitch: pitch,    // Actual pitch in DEGREES (same as ideal for samples)
                        actualYaw: yaw,        // Actual yaw in DEGREES (same as ideal for samples)
                        pitchDelta: 0,         // No delta for sample images
                        yawDelta: 0,           // No delta for sample images
                        roll: 0,               // No tilt for sample images
                        fov: fov,              // Field of view based on pitch
                        timestamp: new Date().toISOString()
                    });
                    
                    loadedCount++;
                    console.log(`Loaded ${filename} (${i}/${totalImages})`);
                    
                    // Update UI if app is available
                    if (window.app) {
                        window.app.capturedHotspots.add(i);
                        window.app.updateProgress();
                        
                        // Update 3D visualization
                        if (window.app.scene) {
                            window.app.scene.markHotspotCaptured(i);
                            const hotspot = window.app.hotspots.find(h => h.id === i);
                            if (hotspot) {
                                // Create blob URL for visualization
                                const blobUrl = URL.createObjectURL(blob);
                                window.app.scene.addCapturedPatch(hotspot, blobUrl);
                                // Note: blob URL will be cleaned up when scene resets
                            }
                        }
                    }
                    
                    infoDiv.textContent = `Loading ${loadedCount}/${totalImages}...`;
                } catch (error) {
                    console.error(`Error loading ${filename}:`, error);
                }
            }
            
            infoDiv.textContent = `Loaded ${loadedCount}/${totalImages}`;
            console.log(`Successfully loaded ${loadedCount} sample images`);
            
            // Hide start screen if visible
            const startScreen = document.getElementById('start-screen');
            if (startScreen) {
                startScreen.style.display = 'none';
            }
            
            // Enable capturing
            if (window.app) {
                window.app.setCapturingEnabled(true);
                if (window.app.scene) {
                    window.app.scene.showCaptureState();
                }
            }
            
        } catch (error) {
            console.error('Error loading sample images:', error);
            infoDiv.textContent = 'Error loading';
        }
    }
    
    blobToDataURL(blob) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
        });
    }

    async clearAllData() {
        const infoDiv = document.getElementById('debug-info');
        await this.database.clearAllImages();
        
        // Clear UI state
        if (window.app) {
            window.app.capturedHotspots.clear();
            window.app.updateProgress();
            if (window.app.scene) {
                window.app.scene.clearCapturedPatches();
            }
        }
        
        infoDiv.textContent = 'Cleared all data';
        console.log('Cleared all data from database');
    }

    async testStitching() {
        console.log('Testing stitching with current data...');
        const infoDiv = document.getElementById('debug-info');
        
        // Check if we have images
        const images = await this.database.loadCapturedImages();
        if (images.length === 0) {
            infoDiv.textContent = 'No images to stitch';
            return;
        }
        
        infoDiv.textContent = `Stitching ${images.length} images...`;
        
        // Trigger stitching in the app
        // window.sphereCapture IS the app instance (capture.js). The old
        // `.app.` path never existed, so this button silently did nothing.
        const app = window.sphereCapture;
        if (app && app.startBestPixelStitching) {
            app.startBestPixelStitching();
        } else {
            console.error('App not available or stitching method not found');
            infoDiv.textContent = 'Error: App not ready';
        }
    }

    updateDebugInfo(message) {
        const infoDiv = document.getElementById('debug-info');
        if (infoDiv) {
            infoDiv.textContent = message;
        }
        console.log(`Debug: ${message}`);
    }

    async exportImages() {
        const infoDiv = document.getElementById('debug-info');
        infoDiv.textContent = 'Loading images...';
        try {
            const images = await this.database.loadCapturedImages();
            if (images.length === 0) {
                infoDiv.textContent = 'No images to export';
                return;
            }
            const { framesZip, framesZipName, saveBlob } = await import('./frame-export.js');
            const blob = await framesZip(images, (n, total) => { infoDiv.textContent = `Processing: ${n}/${total}`; });
            const [newestPanorama] = await this.database.loadAllPanoramas();
            saveBlob(blob, framesZipName(images, newestPanorama));
            infoDiv.textContent = `Exported ${images.length} images`;
        } catch (error) {
            console.error('Error exporting images:', error);
            infoDiv.textContent = 'Export failed';
        }
    }

    async simulateInterruptedStitch() {
        console.log('Simulating interrupted stitch...');
        const infoDiv = document.getElementById('debug-info');
        
        try {
            // Check if we have images
            const images = await this.database.loadCapturedImages();
            if (images.length === 0) {
                infoDiv.textContent = 'No images - load sample images first';
                return;
            }
            
            // Generate a fake job ID
            const jobId = 'debug-' + Date.now();
            
            // Create a stitch job in "running" state
            const job = {
                id: jobId,
                imageIds: images.map(img => String(img.hotspotId)),
                params: { debug: true },
                status: 'running',
                startedAt: Date.now() - 60000, // Started 1 minute ago
                updatedAt: Date.now(),
                retries: 0
            };
            
            // Save the job to database
            await this.database.saveStitchJob(job);
            
            // Set localStorage flags to indicate stitch in progress
            localStorage.setItem('stitch_in_progress', '1');
            localStorage.setItem('stitch_job_id', jobId);
            
            infoDiv.textContent = `Created interrupted stitch job: ${jobId}`;
            console.log('Simulated interrupted stitch job:', job);
            
            // Alert user to reload the page
            if (window.app && window.app.cardUI) {
                await window.app.cardUI.alert(
                    'Simulated an interrupted stitch. Reload the page to test recovery.',
                    'Test Setup Complete'
                );
            } else {
                alert('Simulated an interrupted stitch. Reload the page to test recovery.');
            }
            
        } catch (error) {
            console.error('Failed to simulate interrupted stitch:', error);
            infoDiv.textContent = 'Simulation failed';
        }
    }
}