import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // host: true binds 0.0.0.0, not just localhost — required for the "scan to
  // open on your phone" QR (Qr.tsx) to actually work. Vite's default loopback
  // bind would make that QR encode a URL nothing outside this PC can reach.
  server: { port: 5173, host: true },
  // The wallboard TV runs an OLD Chromium/WebView — old enough that
  // AbortSignal.timeout is missing (see useVoice.ts), which puts it below
  // Chrome 103. Vite 6's default target is 'baseline-widely-available', i.e.
  // Chrome 107+, so the emitted bundle can contain syntax that browser cannot
  // PARSE — and a parse error means no JS runs at all and the screen is simply
  // blank, with nothing in any log to say why. The laptop, on a current
  // browser, shows the same build working perfectly.
  //
  // es2019 is below every feature this app relies on and costs a few KB of
  // downlevelling. Raise it only after checking what the TV actually runs.
  build: { target: 'es2019' },
  // ...and the same for DEV. `build.target` only governs `dist`; the dev server
  // transforms modules on the fly with its own target, so a TV pointed at
  // :5173 would still be served syntax it cannot parse while the built bundle
  // was fine. Both paths have to agree or the wallboard breaks in exactly one
  // of them, which is the hardest version of this bug to find.
  esbuild: { target: 'es2019' },
});
