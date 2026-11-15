/**
 * Frame export: zips a capture session's frames the way the repro harness
 * (tests/repro-real-session.spec.js) reads them, so a bad stitch on a phone
 * can be reproduced on a desktop:
 *   photosphere_images/hotspot_NN_pP_yY.jpg ... + metadata.json
 * JSZip is the local copy (this app makes no third-party requests). JPEGs
 * are stored, not deflated; they do not compress and phones are slow.
 */

export async function framesZip(images, onProgress = () => {}) {
    if (!window.JSZip) {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/js/ext/jszip.min.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }
    const zip = new JSZip();
    const folder = zip.folder('photosphere_images');
    let n = 0;
    for (const img of images) {
        if (!img.imageBlob) continue;
        const ext = { 'image/avif': 'avif', 'image/webp': 'webp' }[img.imageBlob.type] || 'jpg';
        const name = `hotspot_${String(img.hotspotId).padStart(2, '0')}_p${Math.round(img.pitch || 0)}_y${Math.round(img.yaw || 0)}.${ext}`;
        folder.file(name, img.imageBlob);
        onProgress(++n, images.length);
    }
    const metadata = images.map((img) => ({
        hotspotId: img.hotspotId,
        pitch: img.pitch,
        yaw: img.yaw,
        actualPitch: img.actualPitch,
        actualYaw: img.actualYaw,
        roll: img.roll,
        orientationQuaternion: img.orientationQuaternion,
        orientationVersion: img.orientationVersion,
        orientationTimestamp: img.orientationTimestamp,
        videoTime: img.videoTime,
        fov: img.fov,
        width: img.width || 720,
        height: img.height || 1280,
        timestamp: img.timestamp,
    }));
    folder.file('metadata.json', JSON.stringify(metadata, null, 2));
    return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

// YYYYMMDD_HHMMSS in local time, the stamp in photosphere_<stamp>.jpg
export function photosphereStamp(date) {
    const d = new Date(date);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Named after the photosphere stitched from these frames. If the newest
// panorama predates the frames (the stitch failed), use the last frame's time.
export function framesZipName(images, newestPanorama) {
    const lastFrame = Math.max(...images.map((img) => new Date(img.timestamp))) || Date.now();
    const panoTime = newestPanorama ? new Date(newestPanorama.timestamp).getTime() : NaN;
    return `photosphere_${photosphereStamp(panoTime >= lastFrame ? panoTime : lastFrame)}_frames.zip`;
}

export function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 5000);  // iOS needs the URL alive past the click
}
