import { defineConfig, Plugin } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { build as esbuild } from 'esbuild'

/**
 * `import src from './worker.ts?worker-source'` gives the worker bundled into
 * a single self-contained script, as a string. The app turns it into a Blob
 * URL at runtime, so no separate worker file is ever fetched (the Flinsh
 * sandbox has no network and no same-origin files to fetch).
 *
 * We do this instead of Vite's `?worker&inline` because that one base64-encodes
 * the bundle, decodes it with atob (garbles any non-ASCII) and, when Blob URLs
 * fail, falls back to a data: URL worker, which would need `worker-src data:`.
 */
function workerSource(): Plugin {
  const QUERY = '?worker-source'
  return {
    name: 'worker-source',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (!id.endsWith(QUERY)) return
      const resolved = await this.resolve(id.slice(0, -QUERY.length), importer, {
        skipSelf: true
      })
      return resolved && resolved.id + QUERY
    },
    async load(id) {
      if (!id.endsWith(QUERY)) return
      const entry = id.slice(0, -QUERY.length)
      const result = await esbuild({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'iife',
        minify: true,
        target: 'es2019',
        charset: 'utf8',
        metafile: true
      })
      for (const input of Object.keys(result.metafile!.inputs)) {
        this.addWatchFile(input)
      }
      return `export default ${JSON.stringify(result.outputFiles[0].text)}`
    }
  }
}

/** vite-plugin-singlefile 0.6 inlines JS/CSS but still emits the files. */
function dropInlinedFiles(): Plugin {
  return {
    name: 'drop-inlined-files',
    enforce: 'post',
    generateBundle(_, bundle) {
      for (const name of Object.keys(bundle)) {
        if (/\.(js|css)$/.test(name)) delete bundle[name]
      }
    }
  }
}

export default defineConfig({
  plugins: [workerSource(), viteSingleFile(), dropInlinedFiles()],
  build: {
    target: 'es2019',
    chunkSizeWarningLimit: 20000,
    // Inline every asset (textures, fonts, audio, menu image) as a data: URI.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    sourcemap: false,
    brotliSize: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined
      }
    }
  }
})
