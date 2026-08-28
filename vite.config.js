import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],

    test: {
      include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
      environment: 'jsdom',
    },

    preview: {
      host: '0.0.0.0',
      port: process.env.PORT || 4173,
      allowedHosts: ['teclia-academia-1.onrender.com'],
    },
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
      proxy: {
        '/api': {
          target: env.VITE_PROXY_TARGET || 'http://127.0.0.1:3001',
          changeOrigin: true,
          secure: false,
        },
      },
    },
  }
})
