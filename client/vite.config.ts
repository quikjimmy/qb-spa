import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import tailwindcss from '@tailwindcss/vite'

// Where `npm run dev` proxies /api and /uploads. Defaults to the usual 3001,
// so nothing changes for a normal checkout — override it (with a matching
// PORT on the server) to run a second stack from a worktree alongside your
// main dev server instead of fighting over ports.
const apiTarget = process.env['VITE_API_TARGET'] || 'http://localhost:3001'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
  server: {
    proxy: {
      '/api': apiTarget,
      '/uploads': apiTarget,
    },
  },
})
