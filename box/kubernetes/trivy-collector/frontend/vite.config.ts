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
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
    },
  },
})
