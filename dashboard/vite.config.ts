import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // host: true binds 0.0.0.0, not just localhost — required for the "scan to
  // open on your phone" QR (Qr.tsx) to actually work. Vite's default loopback
  // bind would make that QR encode a URL nothing outside this PC can reach.
  server: { port: 5173, host: true },
});
