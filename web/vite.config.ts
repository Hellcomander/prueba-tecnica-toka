import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const contractsSource = fileURLToPath(new URL('../packages/contracts/src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@toka\/contracts\/(.*)$/, replacement: `${contractsSource}/$1` },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  define: {
    __API_MODE__: JSON.stringify(process.env.VITE_API_MODE ?? 'real'),
  },
});
