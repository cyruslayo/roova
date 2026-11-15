import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const localDevKey = process.env.LOCAL_DEV_KEY;
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'http://localhost:8787',
        changeOrigin: true,
        configure: proxy => proxy.on('proxyReq', proxyReq => {
          if (localDevKey) proxyReq.setHeader('X-Local-Dev-Key', localDevKey);
        })
      }
    }
  }
});
