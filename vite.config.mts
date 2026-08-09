import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  html: {
    cspNonce: 'rba-vite',
  },
  plugins: [react()],
  server: {
    strictPort: true,
  },
});
