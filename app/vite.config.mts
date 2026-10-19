import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// onnxruntime-web references its ~28 MB WASM runtime via `new URL(..., import.meta.url)`,
// so Vite always copies it into the build output. At runtime we point
// `ort.env.wasm.wasmPaths` at the pinned jsDelivr CDN instead (see
// src/api-helper/localModel.ts), so the bundled copy is never downloaded.
// Strip it from `dist/` to keep deploys small.
function dropOrtWasm() {
  return {
    name: 'drop-ort-wasm',
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        // Hashed asset name, e.g. ort-wasm-simd-threaded.jsep-MDYUKy93.wasm
        if (fileName.includes('ort-wasm') && fileName.endsWith('.wasm')) {
          delete bundle[fileName];
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), dropOrtWasm()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/setupTests.ts', 'src/vite-env.d.ts'],
    },
  },
});
