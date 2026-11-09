import Core from './core'
import Control from './control'
import Look from './control/look'
import Player from './player'
import Terrain from './terrain'
import UI from './ui'
import Audio from './audio'
import { stats } from './stats'
import { whenFlinshReady, getFlinsh } from './flinsh'

import './style.css'

let ui: UI | undefined
let readySent = false
let bootedWithBridge = false

function boot() {
  bootedWithBridge = !!getFlinsh()
  const core = new Core()
  const camera = core.camera
  const scene = core.scene
  const renderer = core.renderer

  const player = new Player()
  const audio = new Audio(camera)

  const terrain = new Terrain(scene, camera)
  const control = new Control(scene, camera, player, terrain, audio)
  const look = new Look(camera, renderer.domElement, control)

  ui = new UI(terrain, control, look)

  // diagnostics / test hook (used by the Flinsh harness to measure and drive)
  ;(window as any).__mc = { core, terrain, control, look, ui, stats }

  // animation
  ;(function animate(now?: number) {
    requestAnimationFrame(animate)
    now !== undefined && stats.frame(now)

    control.update()
    terrain.update()
    ui!.update()

    renderer.render(scene, camera)
  })()

  // the menu is on screen after the first frame
  requestAnimationFrame(announceReady)
}

/** Tell Flinsh the UI is mounted (once, and only if the bridge is there). */
function announceReady() {
  const flinsh = getFlinsh()
  if (!ui || readySent || !flinsh) return
  readySent = true
  flinsh.ready?.()
}

whenFlinshReady(boot, () => {
  // the bridge may arrive after a standalone start: re-read the save from it
  if (ui && !bootedWithBridge) {
    ui.world.invalidate()
    ui.world.load().catch(() => {})
  }
  ui ? announceReady() : requestAnimationFrame(announceReady)
})
