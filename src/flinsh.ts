/**
 * The window.flinsh bridge that Flinsh injects into the app's sandboxed frame.
 * See Flinch/docs/flinsh-tool-skill.md. Absent when running standalone.
 */
export interface FlinshStoreScope {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<unknown>
  delete(key: string): Promise<boolean>
  list(prefix?: string): Promise<string[]>
}

export interface FlinshBridge {
  input: Record<string, unknown>
  ready(): void
  done(result: unknown): void
  resize(height: number): void
  store: FlinshStoreScope
}

declare global {
  interface Window {
    flinsh?: FlinshBridge
  }
}

export const getFlinsh = (): FlinshBridge | undefined => window.flinsh

/** True when the page runs inside a frame (the Flinsh runner, or a harness). */
export const isEmbedded = (() => {
  try {
    return window.top !== window.self
  } catch {
    return true
  }
})()

/**
 * Start the app once: immediately if the bridge is already there, on the
 * "flinsh:ready" event if it arrives a little later, or standalone after
 * 400 ms. `onBridge` runs whenever the bridge becomes available, including
 * after a standalone start, so the app can switch storage and call ready().
 */
export function whenFlinshReady(start: () => void, onBridge: () => void) {
  let started = false
  const go = () => {
    if (started) return
    started = true
    start()
  }
  if (window.flinsh) {
    go()
    onBridge()
    return
  }
  window.addEventListener(
    'flinsh:ready',
    () => {
      go()
      onBridge()
    },
    { once: true }
  )
  setTimeout(go, 400)
}
