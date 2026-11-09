/**
 * Lightweight timing so the worker path and the main-thread fallback can be
 * compared. Exposed as window.__mc.stats; costs one push per frame.
 */
export interface GenerationSample {
  path: 'worker' | 'main'
  /** wall time from request to result applied */
  wallMs: number
  /** time spent computing (in the worker, or summed main-thread slices) */
  computeMs: number
  slices: number
}

const FRAME_CAP = 3600

class Stats {
  frames: number[] = []
  generations: GenerationSample[] = []
  private last = 0

  frame(now: number) {
    if (this.last) {
      this.frames.push(now - this.last)
      if (this.frames.length > FRAME_CAP) this.frames.shift()
    }
    this.last = now
  }

  generation(s: GenerationSample) {
    this.generations.push(s)
    if (this.generations.length > 200) this.generations.shift()
  }

  reset() {
    this.frames = []
    this.generations = []
    this.last = 0
  }

  summary() {
    const f = this.frames.slice().sort((a, b) => a - b)
    const pct = (p: number) => (f.length ? f[Math.min(f.length - 1, Math.floor(p * f.length))] : 0)
    const g = this.generations
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
    return {
      frames: f.length,
      frameP50: pct(0.5),
      frameP95: pct(0.95),
      frameP99: pct(0.99),
      frameMax: f.length ? f[f.length - 1] : 0,
      framesOver33ms: f.filter(x => x > 33.4).length,
      generations: g.length,
      genWallAvg: avg(g.map(x => x.wallMs)),
      genComputeAvg: avg(g.map(x => x.computeMs)),
      genSlicesAvg: avg(g.map(x => x.slices))
    }
  }
}

export const stats = new Stats()
