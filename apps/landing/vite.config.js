import { defineConfig } from 'vite';

// Port 5176 is apps/web's (see its vite.config.ts and .env.example's
// PLATFORM_APP_URL) — this app was also pinned to 5176 with strictPort,
// so whichever of the two started first silently won the port and the
// other failed to start at all. Moved off onto its own port.
export default defineConfig({
  server: { port: 5177, strictPort: true },
  preview: { port: 5177, strictPort: true },
});
