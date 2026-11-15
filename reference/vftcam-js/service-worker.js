/**
 * VFTCam Service Worker — dependency-free
 * Version: 1.6.34
 * Last Updated: 2026-10-10
 *
 * PRIVACY: this app makes ZERO third-party network requests. The previous
 * service worker imported Workbox from Google's CDN at every startup, which
 * sent every device's IP/user-agent to storage.googleapis.com. This
 * replacement is self-contained, and it actively BLOCKS any cross-origin
 * subresource request so accidental egress fails loudly instead of leaking.
 *
 * Behavior preserved from the Workbox version:
 *  - Precached app shell with version-busted caches
 *  - Cache-first for app assets, network fallback, offline.html for navigations
 *  - './js/…' → '/js/…' URL normalization (iOS Safari module quirk)
 *  - Cached .js always served with a JavaScript Content-Type (iOS quirk)
 *  - skipWaiting/clientsClaim + SKIP_WAITING / GET_VERSION / CLEAR_CACHE messages
 */

// IMPORTANT: Change this version number when updating any cached files
const CACHE_VERSION = '1.6.34';
const CACHE_PREFIX = 'vftcam';

// Precache manifest - timestamp updated by update-sw.py before deploy
const BUILD_TIMESTAMP = '1791693270212'; // Will be updated by update-sw.js

const PRECACHE = `${CACHE_PREFIX}-precache-${CACHE_VERSION}`;
const RUNTIME = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`;

const PRECACHE_URLS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/offline.html',
    '/favicon.ico',
    '/css/capture.css',
    '/css/cards.css',
    '/css/native-tokens.css',
    '/css/native-home.css',
    '/css/native-capture.css',
    '/css/pannellum.css',
    '/fonts/SourceSans3.woff2',
    '/js/capture.js',
    '/js/ext/three.min.js',
    '/js/ext/pannellum.js',
    '/js/ext/piexif.min.js',
    '/js/ext/jszip.min.js',
    '/js/modules/app.js',
    '/js/modules/camera.js',
    '/js/modules/database.js',
    '/js/modules/scene.js',
    '/js/modules/hotspots.js',
    '/js/modules/memory-utils.js',
    '/js/modules/debug.js',
    '/js/modules/device-detector.js',
    '/js/modules/card-ui.js',
    '/js/modules/camera-roll.js',
    '/js/modules/share-utils.js',
    '/js/modules/metadata-utils.js',
    '/js/modules/vr-viewer.js',
    '/js/modules/image-manager.js',
    '/js/modules/permissions.js',
    '/js/modules/pwa-status.js',
    '/js/modules/opfs-storage.js',
    '/js/modules/settings.js',
    '/js/modules/pixelated-transition.js',
    '/js/modules/compass-utils.js',
    '/js/modules/stitch-recovery.js',
    '/js/modules/pole-fill-simple.js',
    '/js/modules/seam-finder.js',
    '/js/modules/capture-orientation.js',
    '/js/modules/zenith-alignment.js',
    '/js/modules/frame-export.js',
    '/js/modules/stitching.js',
    '/js/modules/stitch-processor.js',
    '/js/modules/simple-aligner.js',
    '/js/modules/fov-calibrator.js',
    '/js/modules/fov-estimator.js',
    '/js/modules/manual-fov-test.js',
    '/js/modules/multi-stitcher.js',
    '/js/modules/opencv-utils.js',
    '/js/modules/worker-client.js',
    '/js/workers/opfs-worker.js',
    '/js/workers/stitch-worker.js',
    '/img/vr-cardboard.svg',
    '/img/camera-roll.svg',
    '/img/settings.svg',
    '/img/share.svg',
    '/img/download.svg',
    '/img/trash.svg',
    '/img/fullscreen.svg',
    '/img/view.svg',
    '/img/x.svg',
    '/img/check.svg',
    '/img/question.svg',
    '/img/cloud-slash.svg',
    '/img/geo-alt.svg',
    '/img/compass.svg',
    '/img/database-lock.svg',
    '/img/dash.svg',
    '/img/vr-mask.png',
    '/img/mobile-rotate.svg',
    '/img/camera.svg',
    '/img/logo_150x150.png',
    '/img/icon-192.png',
    '/img/icon-512.png',
    '/img/icon-maskable-192.png',
    '/img/icon-maskable-512.png',
    '/img/about.svg',
    '/img/clear-camera-roll.svg',
    '/img/fov-calibration.svg',
    '/img/privacy.svg',
    '/img/recenter.svg',
    '/img/sliders.svg',
    '/img/favicon-16.png',
    '/img/favicon-32.png',
    '/img/icon-120.png',
    '/img/icon-152.png',
    '/img/icon-167.png',
    '/img/icon-180.png',
    '/img/home.webp',
    '/img/indoor.svg',
    '/img/outdoor.svg'
];

// './js/…' and absolute '/js/…' must hit the same cache entry (iOS Safari
// historically requested both forms for ES modules).
function normalizeUrl(url) {
    const u = new URL(url, self.location.origin);
    u.pathname = u.pathname.replace(/\/\.\//g, '/');
    u.search = '';
    u.hash = '';
    return u.href;
}

// Cached .js must come back with a JavaScript Content-Type or iOS Safari
// refuses to execute it as a module.
async function ensureScriptContentType(response, pathname) {
    if (!pathname.endsWith('.js')) return response;
    const type = response.headers.get('Content-Type') || '';
    if (type.includes('javascript')) return response;
    const headers = new Headers(response.headers);
    headers.set('Content-Type', 'application/javascript');
    const blob = await response.blob();
    return new Response(blob, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

self.addEventListener('install', (event) => {
    console.log(`SW ${CACHE_VERSION} installing (build ${BUILD_TIMESTAMP})`);
    event.waitUntil((async () => {
        const cache = await caches.open(PRECACHE);
        // Tolerant precache: one missing file must not break installation.
        // Each file is fetched with a version query so no HTTP cache (iOS
        // Safari ignores cache: 'reload' here) can hand this version a stale
        // copy, and stored under its plain URL.
        const results = await Promise.allSettled(
            PRECACHE_URLS.map(async (url) => {
                const response = await fetch(url + (url.includes('?') ? '&' : '?') + 'sw=' + CACHE_VERSION, { cache: 'reload' });
                if (!response.ok) throw new Error(`${response.status} for ${url}`);
                await cache.put(url, response);
            })
        );
        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                console.warn('Precache failed for', PRECACHE_URLS[i], r.reason);
            }
        });
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(
            names.map((name) => {
                if (name.startsWith(CACHE_PREFIX) && !name.endsWith(CACHE_VERSION)) {
                    console.log('Deleting old cache', name);
                    return caches.delete(name);
                }
                return undefined;
            })
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // PRIVACY ENFORCEMENT: no cross-origin subresources, ever. Any future
    // accidental third-party dependency fails loudly here instead of leaking
    // user IPs. (Top-level navigation to external links is out of SW scope
    // and unaffected.)
    if (url.origin !== self.location.origin) {
        console.warn('Blocked cross-origin request (privacy policy):', request.url);
        event.respondWith(new Response('Cross-origin requests are disabled in this app.', {
            status: 403,
            statusText: 'Forbidden by privacy policy'
        }));
        return;
    }

    // Navigations: cached shell → network → offline page
    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            const cached = await caches.match('/index.html');
            if (cached) return cached;
            try {
                return await fetch(request);
            } catch (e) {
                return (await caches.match('/offline.html'))
                    || new Response('Offline', { status: 503 });
            }
        })());
        return;
    }

    // Everything else: cache-first with runtime fill
    event.respondWith((async () => {
        const normalized = normalizeUrl(request.url);
        const cached = await caches.match(normalized) || await caches.match(request);
        if (cached) {
            return ensureScriptContentType(cached, url.pathname);
        }
        try {
            const response = await fetch(request);
            if (response && response.ok) {
                const runtime = await caches.open(RUNTIME);
                runtime.put(normalized, response.clone());
            }
            return response;
        } catch (error) {
            console.error('Fetch failed offline:', request.url, error);
            if (url.pathname.endsWith('.js')) {
                // Preserve old behavior: stub script instead of a hard error.
                return new Response(
                    `console.warn("Script not available offline:", ${JSON.stringify(request.url)});`,
                    { headers: { 'Content-Type': 'application/javascript' } }
                );
            }
            return new Response('Not available offline', { status: 503 });
        }
    })());
});

self.addEventListener('message', (event) => {
    if (!event.data) return;

    if (event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }

    if (event.data.type === 'GET_VERSION') {
        event.ports[0].postMessage({ version: CACHE_VERSION });
    }

    if (event.data.type === 'CLEAR_CACHE') {
        caches.keys().then((names) => Promise.all(
            names.map((name) => name.startsWith(CACHE_PREFIX) ? caches.delete(name) : undefined)
        )).then(() => {
            event.ports[0].postMessage({ success: true });
        });
    }
});
