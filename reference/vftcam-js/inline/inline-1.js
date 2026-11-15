
        // Initialize preview canvas with blank thumbnail
        function initializePreviewCanvas() {
            const canvas = document.getElementById('preview-canvas');
            const ctx = canvas.getContext('2d');
            const thumbnailPath = canvas.getAttribute('data-thumbnail');
            
            if (thumbnailPath) {
                const img = new Image();
                img.onload = function() {
                    // Clear canvas and draw the thumbnail
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                };
                img.src = thumbnailPath;
            }
        }
        
        // Initialize canvas when DOM is loaded
        document.addEventListener('DOMContentLoaded', initializePreviewCanvas);
    