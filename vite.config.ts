import { renameSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

function figmaUiOutput(): Plugin {
  return {
    name: 'figma-ui-output',
    closeBundle() {
      renameSync(resolve(__dirname, 'dist/index.html'), resolve(__dirname, 'dist/ui.html'))
    },
  }
}

export default defineConfig(({ mode }) => {
  if (mode === 'plugin') {
    return {
      build: {
        lib: {
          entry: resolve(__dirname, 'src/plugin/main.ts'),
          name: 'DesignPilotPlugin',
          formats: ['iife'],
          fileName: () => 'code.js',
        },
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2020',
        minify: false,
      },
    }
  }

  return {
    root: resolve(__dirname, 'src/ui'),
    plugins: [react(), viteSingleFile(), figmaUiOutput()],
    build: {
      outDir: resolve(__dirname, 'dist'),
      emptyOutDir: false,
      target: 'es2020',
      minify: false,
      rollupOptions: {
        input: { ui: resolve(__dirname, 'src/ui/index.html') },
        output: {
          banner: 'var process = globalThis.process || { env: {} };',
        },
      },
    },
  }
})
