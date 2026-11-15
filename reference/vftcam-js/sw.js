// Redirect to actual service worker
// This file exists as a fallback in case some browsers look for sw.js
self.addEventListener('install', () => {
    console.log('Redirecting to main service-worker.js');
});

// Import the actual service worker
importScripts('/service-worker.js');