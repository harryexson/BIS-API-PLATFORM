import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // Mirrors apps/admin-console/vite.config.ts's proxy — verify-email/
    // reset-password call the real gateway directly by relative path.
    proxy: {
      '/v1': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
