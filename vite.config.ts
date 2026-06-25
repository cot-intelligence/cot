import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Collector base URL. Defaults to the compose-network hostname; override with
// COT_API_TARGET (e.g. http://localhost:31337) when running vite on the host.
const apiTarget = process.env.COT_API_TARGET || 'http://api:31337';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 4000,
    // Bind-mounted source in Docker needs polling for reliable HMR.
    watch: { usePolling: true },
    // Same-origin calls to the collector.
    proxy: {
      '/v1': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
      '/install.sh': { target: apiTarget, changeOrigin: true },
      '/repair.sh': { target: apiTarget, changeOrigin: true },
      '/cot': { target: apiTarget, changeOrigin: true },
    },
  },
});
