/**
 * PWA Status Detection and Installation Manager
 * 
 * Detects installation state, service worker status, and provides
 * platform-specific installation instructions
 */

export class PWAStatus {
    constructor() {
        this.isInstalled = false;
        this.isPersistent = false;
        this.hasServiceWorker = false;
        this.platform = this.detectPlatform();
        this.statusChangeCallbacks = [];
        
        // Check initial status
        this.checkStatus();
        
        // Monitor for changes
        this.startMonitoring();
    }
    
    /**
     * Detect the current platform
     */
    detectPlatform() {
        const ua = navigator.userAgent;
        const isIOS = /iPad|iPhone|iPod/.test(ua);
        const isAndroid = /Android/.test(ua);
        const isChrome = /Chrome/.test(ua) && !/Edge/.test(ua);
        const isSafari = /Safari/.test(ua) && !isChrome;
        
        if (isIOS) {
            return { os: 'ios', browser: isSafari ? 'safari' : 'chrome' };
        } else if (isAndroid) {
            return { os: 'android', browser: isChrome ? 'chrome' : 'other' };
        } else {
            return { os: 'desktop', browser: isChrome ? 'chrome' : 'other' };
        }
    }
    
    /**
     * Check all PWA-related statuses
     */
    async checkStatus() {
        // Check if running as installed PWA
        this.isInstalled = this.checkInstallation();
        
        // Check service worker
        this.hasServiceWorker = await this.checkServiceWorker();
        
        // Check storage persistence
        this.isPersistent = await this.checkPersistence();
        
        // Notify listeners
        this.notifyStatusChange();
        
        return this.getStatus();
    }
    
    /**
     * Check if app is installed (running standalone)
     */
    checkInstallation() {
        // Multiple ways to detect standalone mode
        return window.matchMedia('(display-mode: standalone)').matches ||
               window.navigator.standalone === true ||  // iOS
               document.referrer.includes('android-app://');  // Android TWA
    }
    
    /**
     * Check if service worker is registered and active
     */
    async checkServiceWorker() {
        if (!('serviceWorker' in navigator)) {
            return false;
        }
        
        try {
            const registration = await navigator.serviceWorker.getRegistration();
            return registration && registration.active !== null;
        } catch (error) {
            console.error('Service worker check failed:', error);
            return false;
        }
    }
    
    /**
     * Check if storage is persistent
     */
    async checkPersistence() {
        if (!navigator.storage || !navigator.storage.persisted) {
            return false;
        }
        
        try {
            return await navigator.storage.persisted();
        } catch (error) {
            console.error('Persistence check failed:', error);
            return false;
        }
    }
    
    /**
     * Request persistent storage
     */
    async requestPersistence() {
        if (!navigator.storage || !navigator.storage.persist) {
            return false;
        }
        
        try {
            const granted = await navigator.storage.persist();
            this.isPersistent = granted;
            this.notifyStatusChange();
            return granted;
        } catch (error) {
            console.error('Persistence request failed:', error);
            return false;
        }
    }
    
    /**
     * Get installation instructions for current platform
     */
    getInstallInstructions() {
        const { os, browser } = this.platform;
        
        if (os === 'ios') {
            if (browser === 'safari') {
                return {
                    title: 'Install on iPhone/iPad',
                    steps: [
                        'Tap the Share button (box with arrow) at the bottom of Safari',
                        'Scroll down and tap "Add to Home Screen"',
                        'Tap "Add" in the top right corner',
                        'The app will now be on your home screen'
                    ],
                    icon: '📱'
                };
            } else {
                return {
                    title: 'Install on iPhone/iPad',
                    steps: [
                        'Open this page in Safari (required for iOS)',
                        'Tap the Share button (box with arrow)',
                        'Scroll down and tap "Add to Home Screen"',
                        'Tap "Add" to install'
                    ],
                    icon: '📱',
                    warning: 'iOS requires Safari for installing web apps'
                };
            }
        } else if (os === 'android') {
            if (browser === 'chrome') {
                return {
                    title: 'Install on Android',
                    steps: [
                        'Tap the menu button (3 dots) in Chrome',
                        'Tap "Install app" or "Add to Home screen"',
                        'Tap "Install" in the popup',
                        'The app will be added to your home screen'
                    ],
                    icon: '🤖',
                    canAutoPrompt: true  // Chrome can show install prompt
                };
            } else {
                return {
                    title: 'Install on Android',
                    steps: [
                        'Open this page in Chrome',
                        'Tap the menu button (3 dots)',
                        'Tap "Install app" or "Add to Home screen"',
                        'Tap "Install" to add to home screen'
                    ],
                    icon: '🤖'
                };
            }
        } else {
            return {
                title: 'Desktop Installation',
                steps: [
                    'This app is designed for mobile devices',
                    'Visit on your phone for the best experience',
                    'Installation allows offline use and protects your data'
                ],
                icon: '💻',
                warning: 'Mobile installation recommended'
            };
        }
    }
    
    /**
     * Show install prompt (Android Chrome only)
     */
    async showInstallPrompt() {
        // Check if we have a deferred prompt
        if (window.deferredInstallPrompt) {
            window.deferredInstallPrompt.prompt();
            const { outcome } = await window.deferredInstallPrompt.userChoice;
            console.log('Install prompt outcome:', outcome);
            
            if (outcome === 'accepted') {
                this.isInstalled = true;
                this.notifyStatusChange();
            }
            
            // Clear the deferred prompt
            window.deferredInstallPrompt = null;
            return outcome === 'accepted';
        }
        return false;
    }
    
    /**
     * Get current status summary
     */
    getStatus() {
        return {
            isInstalled: this.isInstalled,
            isPersistent: this.isPersistent,
            hasServiceWorker: this.hasServiceWorker,
            platform: this.platform,
            isOfflineReady: this.hasServiceWorker && (this.isInstalled || this.isPersistent),
            storageRisk: !this.isInstalled && this.platform.os === 'ios' ? 'high' : 'low'
        };
    }
    
    /**
     * Monitor for status changes
     */
    startMonitoring() {
        // Listen for display mode changes
        const displayModeQuery = window.matchMedia('(display-mode: standalone)');
        displayModeQuery.addEventListener('change', () => {
            this.checkStatus();
        });
        
        // Listen for beforeinstallprompt (Android Chrome)
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            window.deferredInstallPrompt = e;
            console.log('Install prompt available');
        });
        
        // Listen for successful installation
        window.addEventListener('appinstalled', () => {
            console.log('PWA installed');
            this.isInstalled = true;
            this.notifyStatusChange();
        });
        
        // Periodic status check (every 5 seconds)
        setInterval(() => this.checkStatus(), 5000);
    }
    
    /**
     * Register a callback for status changes
     */
    onStatusChange(callback) {
        this.statusChangeCallbacks.push(callback);
    }
    
    /**
     * Notify all listeners of status change
     */
    notifyStatusChange() {
        const status = this.getStatus();
        this.statusChangeCallbacks.forEach(callback => {
            try {
                callback(status);
            } catch (error) {
                console.error('Status change callback error:', error);
            }
        });
    }
    
    /**
     * Get storage risk warning message
     */
    getStorageWarning() {
        const status = this.getStatus();
        
        if (status.storageRisk === 'high') {
            return {
                level: 'danger',
                title: 'Storage at Risk',
                message: 'Your browser may delete your photospheres after 7 days of inactivity. Install as an Progressive Web App (Add to Home Screen) to protect your data.',
                action: 'Install to Protect'
            };
        } else if (!status.isPersistent && status.isInstalled) {
            return {
                level: 'warning',
                title: 'Storage Protection Available',
                message: 'Enable storage protection to prevent your device from automatically deleting your photospheres if your device\'s storage is low.',
                action: 'Protect Storage'
            };
        } else if (status.isPersistent) {
            return {
                level: 'success',
                title: 'Storage Protected',
                message: 'Your photospheres are protected from automatic deletion.',
                action: null
            };
        } else {
            return {
                level: 'info',
                title: 'Storage Status',
                message: 'Install as a Progressive Web App for better storage protection.',
                action: 'Learn More'
            };
        }
    }
}