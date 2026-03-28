import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  cacheDir: '/tmp/vite-cache',
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (['react', 'react-dom', 'react-router-dom'].some(p => id.includes(`/node_modules/${p}/`)))
              return 'vendor-react';
            if (id.includes('/node_modules/lucide-react/') || id.includes('/node_modules/react-joyride/'))
              return 'vendor-ui';
            if (id.includes('/node_modules/date-fns/') || id.includes('/node_modules/marked/') || id.includes('/node_modules/dompurify/'))
              return 'vendor-utils';
            if (id.includes('/node_modules/@xyflow/'))
              return 'vendor-flow';
          }
        },
      },
    },
  },
})
