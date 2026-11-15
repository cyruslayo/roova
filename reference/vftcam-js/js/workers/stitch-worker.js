/**
 * Web Worker for Image Processing and Stitching Preparation
 * Handles heavy CPU operations off the main thread to prevent tab reloads
 * Features: retry logic, memory management, progress reporting, cancellation
 */

let isProcessing = false;
let shouldCancel = false;
let lastHeartbeat = Date.now();

// Send heartbeat every 2 seconds to show we're alive
const heartbeatInterval = setInterval(() => {
    if (isProcessing) {
        self.postMessage({ 
            type: 'HEARTBEAT', 
            timestamp: Date.now(),
            memoryUsage: performance.memory?.usedJSHeapSize || 0
        });
    }
}, 2000);

// Handle incoming messages
self.onmessage = async (e) => {
    const { type, data } = e.data;
    
    switch (type) {
        case 'PROCESS':
            await handleProcessRequest(data);
            break;
            
        case 'CANCEL':
            handleCancelRequest();
            break;
            
        case 'PING':
            self.postMessage({ type: 'PONG' });
            break;
            
        case 'CLEANUP':
            handleCleanup();
            break;
            
        default:
            self.postMessage({ 
                type: 'ERROR', 
                message: `Unknown message type: ${type}` 
            });
    }
};

async function handleProcessRequest(data) {
    if (isProcessing) {
        self.postMessage({ 
            type: 'ERROR', 
            message: 'Worker is already processing' 
        });
        return;
    }
    
    isProcessing = true;
    shouldCancel = false;
    lastHeartbeat = Date.now();
    
    try {
        const { captures, targetWidth, targetHeight } = data;
        
        self.postMessage({ 
            type: 'STARTED', 
            totalImages: captures.length 
        });
        
        const layers = await processImages(captures, targetWidth, targetHeight);
        
        if (shouldCancel) {
            throw new Error('Processing cancelled');
        }
        
        // Transfer ownership of ImageBitmaps to main thread
        const bitmapsToTransfer = layers.map(l => l.bitmap).filter(Boolean);
        
        self.postMessage({
            type: 'COMPLETE',
            layers: layers,
            stats: {
                processedCount: layers.length,
                totalRequested: captures.length,
                memoryUsed: performance.memory?.usedJSHeapSize || 0
            }
        }, bitmapsToTransfer);
        
    } catch (error) {
        console.error('Worker processing error:', error);
        self.postMessage({ 
            type: 'ERROR', 
            message: error.message,
            stack: error.stack
        });
    } finally {
        isProcessing = false;
        shouldCancel = false;
    }
}

async function processImages(captures, targetWidth, targetHeight) {
    const layers = [];
    const failedImages = [];
    
    for (let i = 0; i < captures.length; i++) {
        // Check for cancellation
        if (shouldCancel) {
            console.log('Processing cancelled at image', i);
            break;
        }
        
        const capture = captures[i];
        
        try {
            // Process individual image with timeout
            const layer = await Promise.race([
                processImage(capture, targetWidth, targetHeight),
                timeout(10000, `Image ${capture.hotspotId} processing timeout`)
            ]);
            
            if (layer) {
                layers.push(layer);
            }
            
            // Report progress
            self.postMessage({
                type: 'PROGRESS',
                current: i + 1,
                total: captures.length,
                percent: ((i + 1) / captures.length) * 100,
                message: `Processing image ${i + 1} of ${captures.length}`
            });
            
            // Yield periodically to prevent blocking
            if (i % 3 === 0) {
                await delay(10);
            }
            
        } catch (error) {
            console.warn(`Failed to process image ${capture.hotspotId}:`, error);
            failedImages.push({
                hotspotId: capture.hotspotId,
                error: error.message
            });
            
            // Continue with other images
            self.postMessage({
                type: 'WARNING',
                message: `Skipped image ${capture.hotspotId}: ${error.message}`,
                failedCount: failedImages.length
            });
        }
    }
    
    // Check if we have minimum viable set
    if (layers.length < 12) {
        throw new Error(
            `Only ${layers.length} images processed successfully. ` +
            `Need at least 12 for panorama. Failed images: ${failedImages.length}`
        );
    }
    
    // Log statistics
    console.log(`Processed ${layers.length}/${captures.length} images successfully`);
    if (failedImages.length > 0) {
        console.warn('Failed images:', failedImages);
    }
    
    return layers;
}

async function processImage(capture, targetWidth, targetHeight) {
    let bitmap = null;
    let canvas = null;
    
    try {
        // Decode image based on type - check all possible field names
        if (capture.blob || capture.imageBlob) {
            // Blob data (modern format) - database uses 'imageBlob'
            const blob = capture.blob || capture.imageBlob;
            bitmap = await createImageBitmap(blob);
        } else if (capture.imageData) {
            // Base64 data (legacy format)
            bitmap = await decodeBase64Image(capture.imageData);
        } else {
            console.error('Capture object:', capture);
            throw new Error('No image data found in capture object');
        }
        
        // Create OffscreenCanvas for processing
        canvas = new OffscreenCanvas(targetWidth, targetHeight);
        const ctx = canvas.getContext('2d');
        
        if (!ctx) {
            throw new Error('Failed to get 2D context');
        }
        
        // Calculate scaling to maintain aspect ratio
        const scale = Math.min(
            targetWidth / bitmap.width,
            targetHeight / bitmap.height
        );
        
        const scaledWidth = bitmap.width * scale;
        const scaledHeight = bitmap.height * scale;
        const x = (targetWidth - scaledWidth) / 2;
        const y = (targetHeight - scaledHeight) / 2;
        
        // Clear canvas (important for transparency)
        ctx.clearRect(0, 0, targetWidth, targetHeight);
        
        // Draw scaled image centered
        ctx.drawImage(bitmap, x, y, scaledWidth, scaledHeight);
        
        // Clean up source bitmap
        bitmap.close();
        bitmap = null;
        
        // Create final bitmap from canvas
        const finalBitmap = await createImageBitmap(canvas);
        
        // Normalize orientation values - use actual captured positions if available
        // Apply pitch correction if set (for systematic vertical misalignment)
        const pitchCorrection = parseFloat(self.pitchCorrection || '0');

        const normalizedYaw = capture.actualYaw !== undefined ?
            ((capture.actualYaw % 360) + 360) % 360 :
            ((capture.yaw % 360) + 360) % 360;
        const pitch = (capture.actualPitch !== undefined ? capture.actualPitch : capture.pitch) + pitchCorrection;
        const roll = capture.roll || 0;
        
        return {
            bitmap: finalBitmap,
            hotspotId: capture.hotspotId,
            yaw: normalizedYaw,
            pitch: pitch,
            roll: roll,
            width: targetWidth,
            height: targetHeight
        };
        
    } catch (error) {
        // Clean up on error
        if (bitmap) bitmap.close();
        throw new Error(`Failed to process image: ${error.message}`);
    }
}

async function decodeBase64Image(base64Data) {
    // Remove data URL prefix if present
    const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    
    // Convert base64 to blob
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    return await createImageBitmap(blob);
}

function handleCancelRequest() {
    console.log('Cancel requested');
    shouldCancel = true;
    
    if (!isProcessing) {
        self.postMessage({ 
            type: 'CANCELLED', 
            message: 'No processing to cancel' 
        });
    }
}

function handleCleanup() {
    shouldCancel = true;
    isProcessing = false;
    
    // Force garbage collection hint
    if (global.gc) {
        global.gc();
    }
    
    self.postMessage({ type: 'CLEANED' });
}

// Utility functions
function timeout(ms, message = 'Operation timeout') {
    return new Promise((_, reject) => {
        setTimeout(() => reject(new Error(message)), ms);
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Monitor for worker health
self.addEventListener('error', (error) => {
    console.error('Worker error:', error);
    self.postMessage({ 
        type: 'ERROR', 
        message: `Worker error: ${error.message}`,
        filename: error.filename,
        lineno: error.lineno
    });
});

self.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
    self.postMessage({ 
        type: 'ERROR', 
        message: `Unhandled rejection: ${event.reason}` 
    });
});

// Log worker startup
console.log('Stitch worker initialized');
self.postMessage({ type: 'READY' });