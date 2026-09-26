import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // "@/" imports, used by shadcn-registry components such as the lucide-animated icons
  // (tsconfig.app.json has the matching path).
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
