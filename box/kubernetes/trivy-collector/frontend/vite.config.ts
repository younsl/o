import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

export default defineConfig({
  plugins: [react()],
  define: {
    __REACT_VERSION__: JSON.stringify(pkg.dependencies.react.replace('^', '')),
    __TYPESCRIPT_VERSION__: JSON.stringify(pkg.devDependencies.typescript.replace('~', '')),
    __VITE_VERSION__: JSON.stringify(pkg.devDependencies.vite.replace('^', '')),
    __NODE_VERSION__: JSON.stringify(process.version),
  },
  build: {
    outDir: '../static',
    emptyOutDir: true,
    // Note: emptyOutDir deletes all files in ../static/ before build.
    // The .gitignore for build output is at the trivy-collector root level.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Split third-party deps into stable vendor chunks so the main bundle
        // stops tripping Vite's 500kB size warning. Grouping keeps the number
        // of chunks small while isolating the heaviest libraries.
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'vendor-react'
          }
          if (id.includes('/react-router')) return 'vendor-router'
          if (id.includes('/chart.js') || id.includes('/react-chartjs-2')) {
            return 'vendor-chart'
          }
          if (id.includes('/cytoscape')) return 'vendor-cytoscape'
          if (id.includes('/html2canvas')) return 'vendor-html2canvas'
          return 'vendor'
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
    },
  },
})
