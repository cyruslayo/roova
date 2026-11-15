
        // Open settings menu
        window.openSettings = () => {
            if (window.sphereCapture && window.sphereCapture.cardUI) {
                window.sphereCapture.cardUI.showSettingsMenu();
            }
        };

        // Toggle between Indoor and Outdoor capture modes
        window.toggleCaptureMode = () => {
            const modeIcon = document.getElementById('mode-icon');
            const modeText = document.getElementById('mode-text');
            const currentMode = localStorage.getItem('captureMode') || 'outdoor';

            if (currentMode === 'outdoor') {
                // Switch to indoor
                localStorage.setItem('captureMode', 'indoor');
                modeIcon.dataset.mode = 'indoor';
                modeText.textContent = 'Indoor';
            } else {
                // Switch to outdoor
                localStorage.setItem('captureMode', 'outdoor');
                modeIcon.dataset.mode = 'outdoor';
                modeText.textContent = 'Outdoor';
            }
        };

        // Initialize mode display on page load
        window.addEventListener('DOMContentLoaded', () => {
            document.getElementById('tripod-toggle').checked = !!localStorage.getItem('tripodMode');
            const mode = localStorage.getItem('captureMode') || 'outdoor';
            const modeIcon = document.getElementById('mode-icon');
            const modeText = document.getElementById('mode-text');

            if (modeIcon && modeText) {
                if (mode === 'indoor') {
                    modeIcon.dataset.mode = 'indoor';
                    modeText.textContent = 'Indoor';
                } else {
                    modeIcon.dataset.mode = 'outdoor';
                    modeText.textContent = 'Outdoor';
                }
            }
        });

        // Define critical functions inline so they work offline in iOS Safari
        window.startApp = async () => {
            // This will be overridden by the module version when it loads
            // But provides a fallback for offline iOS Safari
            console.log('Using inline startApp fallback');
            
            // Import the module dynamically
            try {
                const module = await import('./js/capture.js');
                if (window.startApp !== arguments.callee) {
                    // Module loaded successfully, use its version
                    return window.startApp();
                }
            } catch (e) {
                console.error('Failed to load capture module:', e);
                alert('The app is having trouble loading. Please refresh the page.');
            }
        };
        
        window.openSettings = () => {
            console.log('Using inline openSettings fallback');
            if (window.sphereCapture && window.sphereCapture.cardUI) {
                window.sphereCapture.cardUI.showSettingsMenu();
            } else {
                alert('Settings not available yet. Please wait for the app to load.');
            }
        };
        
        window.openGallery = async () => {
            console.log('Using inline openGallery fallback');
            if (window.sphereCapture && window.sphereCapture.cameraRoll) {
                await window.sphereCapture.cameraRoll.show();
            } else {
                alert('Gallery not available yet. Please wait for the app to load.');
            }
        };
    