import { getFlinsh } from '../flinsh'

/**
 * Where saves go: window.flinsh.store (the Flinsh user scope) when the bridge
 * is present, localStorage otherwise, and plain memory if localStorage throws
 * (it always does in an opaque-origin sandbox).
 */
export interface KV {
  readonly name: 'flinsh' | 'localStorage' | 'memory'
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

const flinshKV = (): KV | undefined => {
  const store = getFlinsh()?.store
  if (!store) return
  return {
    name: 'flinsh',
    get: k => store.get(k),
    set: async (k, v) => {
      await store.set(k, v)
    },
    delete: async k => {
      await store.delete(k)
    }
  }
}

const localKV = (): KV | undefined => {
  let ls: Storage
  try {
    ls = window.localStorage
    ls.setItem('__probe', '1')
    ls.removeItem('__probe')
  } catch {
    return
  }
  return {
    name: 'localStorage',
    get: async k => {
      const raw = ls.getItem(k)
      return raw === null ? null : JSON.parse(raw)
    },
    set: async (k, v) => ls.setItem(k, JSON.stringify(v)),
    delete: async k => ls.removeItem(k)
  }
}

const memory = new Map<string, string>()
const memoryKV: KV = {
  name: 'memory',
  get: async k => (memory.has(k) ? JSON.parse(memory.get(k)!) : null),
  set: async (k, v) => void memory.set(k, JSON.stringify(v)),
  delete: async k => void memory.delete(k)
}

let cachedLocal: KV | null | undefined
/** Resolved per call: the bridge can arrive after the app has started. */
export const currentKV = (): KV => {
  const f = flinshKV()
  if (f) return f
  if (cachedLocal === undefined) cachedLocal = localKV() ?? null
  return cachedLocal ?? memoryKV
}

// ── World save: a manifest plus fixed-size chunks of the edit list ─────────

/** Bytes per chunk value. Flinsh allows 256 KB per value; stay well under. */
export const CHUNK_BYTES = 128 * 1024
/** Flinsh user scope: 2 MB and 1,000 keys per person per app. */
const QUOTA_BYTES = 2 * 1024 * 1024
const MANIFEST_KEY = 'world/manifest'
const chunkKey = (i: number) => `world/blocks/${String(i).padStart(3, '0')}`

export interface Seeds {
  seed: number
  stoneSeed: number
  treeSeed: number
  coalSeed: number
  leafSeed: number
}
export interface Position {
  x: number
  y: number
  z: number
}
export interface EditRecord {
  x: number
  y: number
  z: number
  type: number
  placed: boolean
}
export interface WorldSnapshot {
  seeds: Seeds
  position: Position
  blocks: EditRecord[]
}
interface Manifest {
  v: 1
  seeds: Seeds
  position: Position
  edits: number
  chunks: number
  bytes: number
  savedAt: number
}

/**
 * Edits are encoded as "x,y,z,type,placed;" records, all ASCII, so string
 * length equals byte length. Breaking a block flips placed 1 -> 0 in place
 * (same length) and new edits append, so earlier chunks stay byte-identical
 * and only the chunks that changed are rewritten.
 */
export const encodeEdits = (blocks: EditRecord[]) => {
  let out = ''
  for (const b of blocks) out += `${b.x},${b.y},${b.z},${b.type},${b.placed ? 1 : 0};`
  return out
}

export const decodeEdits = (s: string): EditRecord[] => {
  const out: EditRecord[] = []
  for (const rec of s.split(';')) {
    if (!rec) continue
    const [x, y, z, type, placed] = rec.split(',').map(Number)
    if ([x, y, z, type, placed].some(n => !Number.isFinite(n))) continue
    out.push({ x, y, z, type, placed: placed === 1 })
  }
  return out
}

const sliceChunks = (s: string) => {
  const chunks: string[] = []
  for (let i = 0; i < s.length; i += CHUNK_BYTES) chunks.push(s.slice(i, i + CHUNK_BYTES))
  return chunks
}

export interface SaveReport {
  backend: KV['name']
  totalBytes: number
  chunks: number
  chunksWritten: number
  chunksDeleted: number
  edits: number
}

/**
 * Saves and loads the world. Saves are serialized (never two at once) and
 * coalesced: requestSave() during a burst of edits produces one write after
 * the burst; flush() writes now and resolves when it is stored.
 */
export class WorldStore {
  constructor(snapshot: () => WorldSnapshot) {
    this.snapshot = snapshot
  }

  private snapshot: () => WorldSnapshot
  /** what we believe is stored, per backend, so unchanged chunks are skipped */
  private written: { backend: string; chunks: string[] } | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private firstPendingAt = 0
  private loadPromise?: Promise<WorldSnapshot | null>

  lastReport?: SaveReport
  onError?: (e: Error) => void

  /** Debounced save: waits for 1 s of quiet, but never more than 5 s. */
  requestSave() {
    const now = performance.now()
    if (!this.timer) this.firstPendingAt = now
    clearTimeout(this.timer)
    const wait = Math.max(0, Math.min(1000, this.firstPendingAt + 5000 - now))
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush().catch(e => this.onError?.(e))
    }, wait)
  }

  cancelPending() {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /**
   * Save now (after any save already in flight). The world is captured
   * synchronously, so resetting it right after calling flush() is safe.
   */
  flush(): Promise<SaveReport> {
    this.cancelPending()
    const snap = this.snapshot()
    const run = this.chain.catch(() => {}).then(() => this.write(snap))
    this.chain = run
    return run
  }

  private async write(snap: WorldSnapshot): Promise<SaveReport> {
    const kv = currentKV()
    const encoded = encodeEdits(snap.blocks)
    const chunks = sliceChunks(encoded)
    const totalBytes = encoded.length + 2 * chunks.length + 300
    if (totalBytes > QUOTA_BYTES - 16 * 1024) {
      throw new Error(
        `world too large to save (${Math.round(totalBytes / 1024)} KB of edits, limit about 2 MB)`
      )
    }

    const prev = this.written?.backend === kv.name ? this.written.chunks : null
    let prevCount = prev?.length
    if (prevCount === undefined) {
      // first save to this backend: learn how many chunks are there now
      const m = (await kv.get(MANIFEST_KEY)) as Manifest | null
      prevCount = m?.chunks ?? 0
    }

    let chunksWritten = 0
    for (let i = 0; i < chunks.length; i++) {
      if (prev && prev[i] === chunks[i]) continue
      await kv.set(chunkKey(i), chunks[i])
      chunksWritten++
    }

    // manifest last: it is what makes the new chunks count
    const manifest: Manifest = {
      v: 1,
      seeds: snap.seeds,
      position: snap.position,
      edits: snap.blocks.length,
      chunks: chunks.length,
      bytes: encoded.length,
      savedAt: Date.now()
    }
    await kv.set(MANIFEST_KEY, manifest)

    let chunksDeleted = 0
    for (let i = chunks.length; i < prevCount; i++) {
      await kv.delete(chunkKey(i)).catch(() => {})
      chunksDeleted++
    }

    this.written = { backend: kv.name, chunks }
    this.lastReport = {
      backend: kv.name,
      totalBytes: encoded.length + JSON.stringify(manifest).length,
      chunks: chunks.length,
      chunksWritten,
      chunksDeleted,
      edits: snap.blocks.length
    }
    return this.lastReport
  }

  /** Forget the prefetched save (e.g. the bridge arrived late). */
  invalidate() {
    this.loadPromise = undefined
    this.written = null
  }

  /** Load the saved world, or null. Cached, so it can be prefetched at boot. */
  load(): Promise<WorldSnapshot | null> {
    if (!this.loadPromise) {
      this.loadPromise = this.read()
      this.loadPromise.catch(() => (this.loadPromise = undefined))
    }
    return this.loadPromise
  }

  private async read(): Promise<WorldSnapshot | null> {
    const kv = currentKV()
    const m = (await kv.get(MANIFEST_KEY)) as Manifest | null
    if (!m) return kv.name === 'localStorage' ? readLegacy() : null

    const chunks = await Promise.all(
      Array.from({ length: m.chunks }, (_, i) => kv.get(chunkKey(i)))
    )
    const strings = chunks.map(c => (typeof c === 'string' ? c : ''))
    const encoded = strings.join('')
    if (encoded.length !== m.bytes) {
      console.warn(`[save] expected ${m.bytes} bytes of edits, found ${encoded.length}`)
    }
    this.written = { backend: kv.name, chunks: strings }
    return { seeds: m.seeds, position: m.position, blocks: decodeEdits(encoded) }
  }
}

/** Saves made by the original game: localStorage block/seed/position. */
function readLegacy(): WorldSnapshot | null {
  try {
    const ls = window.localStorage
    const blocks = JSON.parse(ls.getItem('block') || 'null') as EditRecord[] | null
    const seed = Number(JSON.parse(ls.getItem('seed') || 'null'))
    if (!blocks || !Number.isFinite(seed)) return null
    const position = JSON.parse(ls.getItem('position') || 'null') ?? { x: 8, y: 50, z: 8 }
    // the original only saved the terrain seed; derive the rest like Noise does
    return {
      seeds: {
        seed,
        stoneSeed: seed * 0.4,
        treeSeed: seed * 0.7,
        coalSeed: seed * 0.5,
        leafSeed: seed * 0.8
      },
      position,
      blocks: blocks.map(b => ({ x: b.x, y: b.y, z: b.z, type: b.type, placed: b.placed }))
    }
  } catch {
    return null
  }
}
