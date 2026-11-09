import workerSource from './worker/generate.ts?worker-source'
import { generateTerrain, GenerateParams, GenerateResult } from './generator'
import { stats } from '../stats'

export type GeneratePath = 'pending' | 'worker' | 'main'

/** How long a freshly started worker has to say "ready" before we give up. */
const WORKER_HANDSHAKE_MS = 1500
/** Main-thread slice budgets (ms of generation work per slice). */
const SLICE_BUDGET_MS = 4
const URGENT_SLICE_BUDGET_MS = 40

const ric: ((cb: (d: { timeRemaining(): number; didTimeout: boolean }) => void, o?: { timeout: number }) => number) | undefined =
  (window as any).requestIdleCallback?.bind(window)

/**
 * Runs terrain generation in a Web Worker built from a Blob URL (no file is
 * fetched). If the worker cannot be created (CSP without `worker-src blob:`,
 * Workers disabled) it falls back to generating on the main thread in small
 * idle-time slices, so the game keeps working, just with a little more jank.
 *
 * Only the newest request matters: older main-thread jobs are cancelled and
 * older worker results are dropped.
 */
export default class GenerateRunner {
  constructor(onResult: (r: GenerateResult) => void, forcePath?: 'main') {
    this.onResult = onResult
    if (forcePath === 'main') this.useMainThread('forced')
    else this.startWorker()
  }

  path: GeneratePath = 'pending'
  /** why we are on the main thread, for diagnostics */
  fallbackReason = ''

  private onResult: (r: GenerateResult) => void
  private worker?: Worker
  private seq = 0
  private queued?: { id: number; params: GenerateParams; urgent: boolean; t0: number }
  private sent = new Map<number, number>()
  private mainJob = 0

  request(params: GenerateParams, urgent = false) {
    const job = { id: ++this.seq, params, urgent, t0: performance.now() }
    if (this.path === 'pending') {
      this.queued = job
    } else if (this.path === 'worker') {
      this.sent.set(job.id, job.t0)
      this.worker!.postMessage({ id: job.id, params })
    } else {
      this.runOnMainThread(job)
    }
  }

  private startWorker() {
    let url = ''
    try {
      if (typeof Worker === 'undefined') throw new Error('Worker is not available')
      url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
      // Throws synchronously in some browsers when the CSP forbids blob: workers
      const worker = new Worker(url)
      this.worker = worker

      const timer = setTimeout(() => fail('worker did not start (likely blocked by CSP worker-src)'), WORKER_HANDSHAKE_MS)
      const fail = (reason: string) => {
        clearTimeout(timer)
        if (this.path !== 'pending') return
        worker.terminate()
        this.worker = undefined
        URL.revokeObjectURL(url)
        this.useMainThread(reason)
      }
      // Others (Chrome today) refuse asynchronously with an error event
      worker.onerror = e => {
        e.preventDefault?.()
        fail('worker error: ' + (e.message || 'blocked'))
      }
      worker.onmessage = (msg: MessageEvent) => {
        const d = msg.data
        if (d.type === 'ready') {
          clearTimeout(timer)
          URL.revokeObjectURL(url)
          this.path = 'worker'
          worker.onerror = e => console.error('[terrain worker]', e.message)
          this.flushQueue()
        } else if (d.type === 'result') {
          const t0 = this.sent.get(d.id)
          this.sent.delete(d.id)
          // drop stale results: a newer request is already in flight
          if (d.id !== this.seq) return
          this.sent.clear()
          this.onResult(d.result)
          stats.generation({
            path: 'worker',
            wallMs: t0 === undefined ? 0 : performance.now() - t0,
            computeMs: d.ms,
            slices: 1
          })
        }
      }
    } catch (e) {
      url && URL.revokeObjectURL(url)
      this.useMainThread('new Worker threw: ' + (e as Error).message)
    }
  }

  private useMainThread(reason: string) {
    this.path = 'main'
    this.fallbackReason = reason
    console.info('[terrain] generating on the main thread:', reason)
    this.flushQueue()
  }

  private flushQueue() {
    const q = this.queued
    this.queued = undefined
    if (!q) return
    if (this.path === 'worker') {
      this.sent.set(q.id, q.t0)
      this.worker!.postMessage({ id: q.id, params: q.params })
    } else {
      this.runOnMainThread(q)
    }
  }

  private runOnMainThread(job: { id: number; params: GenerateParams; urgent: boolean; t0: number }) {
    const jobId = ++this.mainJob
    const it = generateTerrain(job.params)
    let computeMs = 0
    let slices = 0

    const step = (budget: number) => {
      if (jobId !== this.mainJob) return // superseded by a newer request
      const start = performance.now()
      slices++
      for (;;) {
        const r = it.next()
        if (r.done) {
          computeMs += performance.now() - start
          this.onResult(r.value)
          stats.generation({ path: 'main', wallMs: performance.now() - job.t0, computeMs, slices })
          return
        }
        if (performance.now() - start >= budget) break
      }
      computeMs += performance.now() - start
      schedule()
    }

    const schedule = () => {
      if (job.urgent) {
        setTimeout(() => step(URGENT_SLICE_BUDGET_MS), 0)
      } else if (ric) {
        ric(d => step(d.didTimeout ? SLICE_BUDGET_MS : Math.max(2, Math.min(8, d.timeRemaining()))), { timeout: 50 })
      } else {
        setTimeout(() => step(SLICE_BUDGET_MS), 0)
      }
    }
    schedule()
  }
}
