import { generateAll, GenerateParams } from '../generator'

// Bundled by the `?worker-source` plugin (vite.config.ts) into one classic
// script and started from a Blob URL. Tell the page we are alive, so it can
// tell a working worker from one the CSP silently refused.
const ctx = self as unknown as {
  onmessage: ((msg: MessageEvent) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

ctx.onmessage = (msg: MessageEvent<{ id: number; params: GenerateParams }>) => {
  const t0 = performance.now()
  const { arrays, blocksCount } = generateAll(msg.data.params)
  // idMap stays here: the main thread never reads it, and structured-cloning
  // a Map with ~100k string keys cost up to 300 ms of main-thread time
  const result = { arrays, blocksCount }
  ctx.postMessage(
    { type: 'result', id: msg.data.id, result, ms: performance.now() - t0 },
    arrays.map(a => a.buffer)
  )
}

ctx.postMessage({ type: 'ready' })
