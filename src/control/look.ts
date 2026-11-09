import * as THREE from 'three'
import { isMobile } from '../utils'

export type LookMode = 'pointer' | 'drag' | 'touch'

export interface GameLockDetail {
  locked: boolean
  mode: LookMode
}

/** Fired on document whenever play starts or pauses, in every look mode. */
export const GAME_LOCK = 'game:lock'

const DRAG_THRESHOLD_PX = 6
const HOLD_MS = 250
const PI_2 = Math.PI / 2

interface ActionTarget {
  mousedownHandler(e: MouseEvent): void
  mouseupHandler(): void
}

/**
 * How the player looks around.
 *
 * - pointer: the original Pointer Lock behaviour (mouse captured, Esc/E pauses).
 * - drag:    used when pointer lock is missing or refused, e.g. in a sandboxed
 *            iframe without `allow-pointer-lock`. Drag on the canvas to look;
 *            a click without dragging breaks (left) or places (right) a block;
 *            holding still keeps breaking, like holding the mouse button.
 * - touch:   phones/tablets, handled by the on-screen joystick.
 *
 * Whatever the mode, play/pause is announced with one GAME_LOCK event, so the
 * rest of the game does not care which mode is active.
 */
export default class Look {
  constructor(camera: THREE.Camera, canvas: HTMLElement, actions: ActionTarget) {
    this.camera = camera
    this.canvas = canvas
    this.actions = actions

    if (isMobile) this.mode = 'touch'
    else if (!('requestPointerLock' in Element.prototype)) this.mode = 'drag'
    else this.mode = 'pointer'

    document.addEventListener('pointerlockchange', this.onPointerLockChange)
    document.addEventListener('pointerlockerror', this.onPointerLockError)

    canvas.addEventListener('pointerdown', this.onDragDown)
    canvas.addEventListener('pointermove', this.onDragMove)
    canvas.addEventListener('pointerup', this.onDragUp)
    canvas.addEventListener('pointercancel', this.onDragUp)

    document.body.addEventListener('keydown', e => {
      if (this.mode === 'drag' && this.active && (e.key === 'Escape' || e.key === 'e')) {
        this.unlock()
      }
    })
  }

  mode: LookMode
  active = false
  /** set when we fell back from pointer to drag, with the reason */
  fallbackReason = ''
  onModeChange?: (mode: LookMode) => void

  private camera: THREE.Camera
  private canvas: HTMLElement
  private actions: ActionTarget
  private everLocked = false
  private lockTimer?: ReturnType<typeof setTimeout>
  private euler = new THREE.Euler(0, 0, 0, 'YXZ')

  lock() {
    if (this.mode === 'pointer') {
      if (document.pointerLockElement) return
      this.requestPointerLock()
    } else {
      this.setActive(true)
    }
  }

  unlock() {
    if (this.mode === 'pointer') {
      document.pointerLockElement && document.exitPointerLock()
    } else {
      this.setActive(false)
    }
  }

  private setActive(locked: boolean) {
    this.active = locked
    document.dispatchEvent(
      new CustomEvent<GameLockDetail>(GAME_LOCK, { detail: { locked, mode: this.mode } })
    )
  }

  // ── pointer lock ──────────────────────────────────────────────────────────

  private requestPointerLock() {
    try {
      const r = document.body.requestPointerLock() as unknown
      // newer browsers return a promise; a sandbox refusal rejects it
      if (r && typeof (r as Promise<void>).catch === 'function') {
        ;(r as Promise<void>).catch(e => this.onPointerLockError(e))
      }
    } catch (e) {
      this.onPointerLockError(e)
      return
    }
    if (!this.everLocked) {
      // some browsers neither lock nor report an error when refused
      clearTimeout(this.lockTimer)
      this.lockTimer = setTimeout(() => {
        if (!document.pointerLockElement && !this.everLocked) {
          this.fallBackToDrag('pointer lock request had no answer')
        }
      }, 1500)
    }
  }

  private onPointerLockChange = () => {
    if (this.mode !== 'pointer') return
    const locked = !!document.pointerLockElement
    if (locked) {
      this.everLocked = true
      clearTimeout(this.lockTimer)
    }
    this.setActive(locked)
  }

  private onPointerLockError = (e?: unknown) => {
    if (this.mode !== 'pointer') return
    clearTimeout(this.lockTimer)
    if (!this.everLocked) {
      // never worked: treat as "not permitted here" (sandbox without
      // allow-pointer-lock, or a browser policy) and switch for good
      const msg = e instanceof Error ? e.message : 'pointerlockerror'
      this.fallBackToDrag(msg)
    } else {
      // it worked before; this is a transient refusal (e.g. re-locking too
      // soon after Esc). Stay in pointer mode and show the menu again.
      this.setActive(false)
    }
  }

  private fallBackToDrag(reason: string) {
    if (this.mode === 'drag') return
    console.info('[look] pointer lock unavailable, using drag-to-look:', reason)
    this.mode = 'drag'
    this.fallbackReason = reason
    this.onModeChange?.('drag')
    // the player already pressed Play: start the game in drag mode
    this.setActive(true)
  }

  // ── drag to look ──────────────────────────────────────────────────────────

  private press?: {
    id: number
    button: number
    x: number
    y: number
    lastX: number
    lastY: number
    dragged: boolean
    acting: boolean
    timer?: ReturnType<typeof setTimeout>
  }

  private fakeMouse = (button: number) =>
    ({ button, preventDefault: () => {} } as unknown as MouseEvent)

  private onDragDown = (e: PointerEvent) => {
    if (this.mode !== 'drag' || !this.active || this.press) return
    if (e.button !== 0 && e.button !== 2) return
    e.preventDefault()
    this.canvas.setPointerCapture?.(e.pointerId)
    const press: NonNullable<Look['press']> = {
      id: e.pointerId,
      button: e.button,
      x: e.clientX,
      y: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      dragged: false,
      acting: false
    }
    // holding still starts the action (and its repeat), like a held button
    press.timer = setTimeout(() => {
      if (!press.dragged && this.press === press) {
        press.acting = true
        this.actions.mousedownHandler(this.fakeMouse(press.button))
      }
    }, HOLD_MS)
    this.press = press
  }

  private onDragMove = (e: PointerEvent) => {
    const p = this.press
    if (!p || e.pointerId !== p.id) return
    if (!p.dragged && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_THRESHOLD_PX) {
      p.dragged = true
      clearTimeout(p.timer)
    }
    if (p.dragged) {
      this.rotate(e.clientX - p.lastX, e.clientY - p.lastY)
    }
    p.lastX = e.clientX
    p.lastY = e.clientY
  }

  private onDragUp = (e: PointerEvent) => {
    const p = this.press
    if (!p || e.pointerId !== p.id) return
    this.press = undefined
    clearTimeout(p.timer)
    this.canvas.releasePointerCapture?.(e.pointerId)
    if (p.acting) {
      this.actions.mouseupHandler()
    } else if (!p.dragged && e.type === 'pointerup') {
      // a click: one action
      this.actions.mousedownHandler(this.fakeMouse(p.button))
      this.actions.mouseupHandler()
    }
  }

  /** Same feel as PointerLockControls (0.002 rad per pixel), a bit faster. */
  private rotate(dx: number, dy: number) {
    this.euler.setFromQuaternion(this.camera.quaternion)
    this.euler.y -= dx * 0.004
    this.euler.x -= dy * 0.004
    this.euler.x = Math.max(-PI_2, Math.min(PI_2, this.euler.x))
    this.camera.quaternion.setFromEuler(this.euler)
  }
}
