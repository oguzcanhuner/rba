import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
