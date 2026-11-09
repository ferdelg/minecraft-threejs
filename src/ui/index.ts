import FPS from './fps'
import Bag from './bag'
import Terrain from '../terrain'
import Block from '../terrain/mesh/block'
import Control from '../control'
import Look, { GAME_LOCK, GameLockDetail } from '../control/look'
import { Mode } from '../player'
import Joystick from './joystick'
import { WorldStore, WorldSnapshot } from '../storage'
import { isEmbedded } from '../flinsh'
import * as THREE from 'three'

export default class UI {
  constructor(terrain: Terrain, control: Control, look: Look) {
    this.fps = new FPS()
    this.bag = new Bag()
    this.joystick = new Joystick(control)
    this.look = look
    this.terrain = terrain

    this.crossHair.className = 'cross-hair'
    this.crossHair.innerHTML = '+'
    document.body.appendChild(this.crossHair)

    this.hint.className = 'look-hint hidden'
    this.hint.textContent =
      'Drag to look · click: break · right-click: place · E: menu'
    document.body.appendChild(this.hint)

    // a sandboxed frame cannot open the GitHub link (no popups), and on a
    // phone it covers the menu; the project link lives in the README
    isEmbedded && this.github?.remove()

    // saving: Flinsh store when available, localStorage otherwise
    this.world = new WorldStore(this.snapshot)
    this.world.onError = e => this.toast(`Couldn't save: ${e.message}`, true)
    terrain.onEdit = () => this.persisted && this.world.requestSave()
    // start reading the save now, so "Load Game" is instant
    this.world.load().catch(() => {})

    this.joystick.onMenu = () => look.unlock()

    // play
    this.play?.addEventListener('click', () => {
      if (this.play?.innerHTML === 'Play') {
        // keep the previous world's pending autosave before replacing it
        this.persisted && this.world.flush().catch(e => this.world.onError?.(e))
        this.persisted = false

        this.onPlay()

        // reset game
        terrain.noise.seed = Math.random()
        terrain.noise.stoneSeed = Math.random()
        terrain.noise.treeSeed = Math.random()
        terrain.noise.coalSeed = Math.random()
        terrain.noise.leafSeed = Math.random()
        terrain.customBlocks = []
        terrain.initBlocks()
        terrain.urgentNext = true
        terrain.generate()
        terrain.camera.position.y = 40
        control.player.setMode(Mode.walking)
      }
      look.lock()
    })

    // save load
    this.save?.addEventListener('click', async () => {
      if (!this.save || this.busy) return
      if (this.save.innerHTML === 'Save and Exit') {
        this.busy = true
        try {
          const report = await this.world.flush()
          this.persisted = true
          this.onExit()
          this.toast(
            report.backend === 'memory'
              ? 'Saved for this session only'
              : 'Game Saved!'
          )
        } catch (e) {
          this.toast(`Couldn't save: ${(e as Error).message}`, true)
        } finally {
          this.busy = false
        }
      } else {
        // lock first, while we still have the click's user activation
        this.onPlay()
        look.lock()
        this.busy = true
        try {
          const snap = await this.world.load()
          if (snap) {
            this.applySnapshot(snap)
            this.persisted = true
            this.toast('Game Loaded!', false, true)
          } else {
            this.newWorldFromLoad()
            this.toast('No saved game yet: new world', false, true)
          }
        } catch (e) {
          look.unlock()
          this.onExit()
          this.toast(`Couldn't load: ${(e as Error).message}`, true)
        } finally {
          this.busy = false
        }
      }
    })

    // guide
    this.feature?.addEventListener('click', () => {
      this.features?.classList.remove('hidden')
    })
    this.back?.addEventListener('click', () => {
      this.features?.classList.add('hidden')
    })

    // setting
    this.setting?.addEventListener('click', () => {
      this.settings?.classList.remove('hidden')
    })
    this.settingBack?.addEventListener('click', () => {
      this.settings?.classList.add('hidden')
    })

    // render distance
    this.distanceInput?.addEventListener('input', (e: Event) => {
      if (this.distance && e.target instanceof HTMLInputElement) {
        this.distance.innerHTML = `Render Distance: ${e.target.value}`
      }
    })

    // fov
    this.fovInput?.addEventListener('input', (e: Event) => {
      if (this.fov && e.target instanceof HTMLInputElement) {
        this.fov.innerHTML = `Field of View: ${e.target.value}`
        control.camera.fov = parseInt(e.target.value)
        control.camera.updateProjectionMatrix()
      }
    })

    // music
    this.musicInput?.addEventListener('input', (e: Event) => {
      if (this.fov && e.target instanceof HTMLInputElement) {
        const disabled = e.target.value === '0'
        control.audio.disabled = disabled
        this.music!.innerHTML = `Music: ${disabled ? 'Off' : 'On'}`
      }
    })

    // apply settings
    this.settingBack?.addEventListener('click', () => {
      if (this.distanceInput instanceof HTMLInputElement) {
        terrain.distance = parseInt(this.distanceInput.value)
        terrain.maxCount =
          (terrain.distance * terrain.chunkSize * 2 + terrain.chunkSize) ** 2 +
          500

        terrain.initBlocks()
        terrain.generate()
        terrain.scene.fog = new THREE.Fog(
          0x87ceeb,
          1,
          terrain.distance * 24 + 24
        )
      }
    })

    // menu and fullscreen
    document.body.addEventListener('keydown', (e: KeyboardEvent) => {
      // menu (drag mode handles E / Esc itself)
      if (e.key === 'e' && look.mode === 'pointer' && document.pointerLockElement) {
        look.unlock()
      }

      // fullscreen (refused in a frame without allow="fullscreen"; ignore)
      if (e.key === 'f') {
        try {
          const r = document.fullscreenElement
            ? document.exitFullscreen?.()
            : document.body.requestFullscreen?.()
          r?.catch(() => {})
        } catch {}
      }
    })

    // exit
    this.exit?.addEventListener('click', () => {
      this.persisted && this.world.flush().catch(e => this.world.onError?.(e))
      this.onExit()
    })

    // play / pause handler (pointer lock, drag or touch)
    document.addEventListener(GAME_LOCK, e => {
      const { locked } = (e as CustomEvent<GameLockDetail>).detail
      if (locked) {
        this.onPlay()
      } else {
        this.onPause()
        // keep the player's position with the world
        this.persisted && this.world.requestSave()
      }
    })

    // the frame can be closed at any time; save what we have
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.persisted) {
        this.world.flush().catch(() => {})
      }
    })

    // disable context menu
    document.addEventListener('contextmenu', e => {
      e.preventDefault()
    })

    // fallback lock handler
    document.querySelector('canvas')?.addEventListener('click', (e: Event) => {
      e.preventDefault()
      look.mode === 'pointer' && !look.active && look.lock()
    })
  }

  fps: FPS
  bag: Bag
  joystick: Joystick
  look: Look
  terrain: Terrain
  world: WorldStore
  /** the current world is the saved one, so edits autosave */
  persisted = false
  busy = false

  menu = document.querySelector('.menu')
  crossHair = document.createElement('div')
  hint = document.createElement('div')
  hintTimer?: ReturnType<typeof setTimeout>

  // buttons
  play = document.querySelector('#play')
  control = document.querySelector('#control')
  setting = document.querySelector('#setting')
  feature = document.querySelector('#feature')
  back = document.querySelector('#back')
  exit = document.querySelector('#exit')
  save = document.querySelector('#save')

  // modals
  saveModal = document.querySelector('.save-modal')
  loadModal = document.querySelector('.load-modal')
  settings = document.querySelector('.settings')
  features = document.querySelector('.features')
  github = document.querySelector('.github')

  // settings
  distance = document.querySelector('#distance')
  distanceInput = document.querySelector('#distance-input')

  fov = document.querySelector('#fov')
  fovInput = document.querySelector('#fov-input')

  music = document.querySelector('#music')
  musicInput = document.querySelector('#music-input')

  settingBack = document.querySelector('#setting-back')

  snapshot = (): WorldSnapshot => {
    const { noise, camera, customBlocks } = this.terrain
    return {
      seeds: {
        seed: noise.seed,
        stoneSeed: noise.stoneSeed,
        treeSeed: noise.treeSeed,
        coalSeed: noise.coalSeed,
        leafSeed: noise.leafSeed
      },
      position: {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z
      },
      // copy: the live list is mutated in place while a save is in flight
      blocks: customBlocks.map(b => ({
        x: b.x,
        y: b.y,
        z: b.z,
        type: b.type,
        placed: b.placed
      }))
    }
  }

  applySnapshot = (snap: WorldSnapshot) => {
    const terrain = this.terrain
    Object.assign(terrain.noise, snap.seeds)
    terrain.customBlocks = snap.blocks.map(
      b => new Block(b.x, b.y, b.z, b.type, b.placed)
    )
    terrain.camera.position.set(snap.position.x, snap.position.y, snap.position.z)
    // generate around the saved position directly (not around the old one)
    terrain.chunk.set(
      Math.floor(snap.position.x / terrain.chunkSize),
      Math.floor(snap.position.z / terrain.chunkSize)
    )
    terrain.previousChunk.copy(terrain.chunk)
    terrain.initBlocks()
    terrain.urgentNext = true
    terrain.generate()
  }

  newWorldFromLoad = () => {
    const terrain = this.terrain
    terrain.noise.seed = Math.random()
    terrain.customBlocks = []
    terrain.initBlocks()
    terrain.urgentNext = true
    terrain.generate()
    terrain.camera.position.y = 40
  }

  onPlay = () => {
    this.look.mode === 'touch' && this.joystick.show()
    this.menu?.classList.add('hidden')
    this.menu?.classList.remove('start')
    this.play && (this.play.innerHTML = 'Resume')
    this.crossHair.classList.remove('hidden')
    this.github && this.github.classList.add('hidden')
    this.feature?.classList.add('hidden')
    if (this.look.mode === 'drag' && this.look.active) {
      this.hint.classList.remove('hidden')
      clearTimeout(this.hintTimer)
      this.hintTimer = setTimeout(() => this.hint.classList.add('hidden'), 8000)
    }
  }

  onPause = () => {
    this.joystick.hide()
    this.hint.classList.add('hidden')
    this.menu?.classList.remove('hidden')
    this.crossHair.classList.add('hidden')
    this.save && (this.save.innerHTML = 'Save and Exit')
    this.github && this.github.classList.remove('hidden')
  }

  onExit = () => {
    this.menu?.classList.add('start')
    this.play && (this.play.innerHTML = 'Play')
    this.save && (this.save.innerHTML = 'Load Game')
    this.feature?.classList.remove('hidden')
  }

  /** The original's save/load banners, reused for any short message. */
  toast = (text: string, error = false, loadStyle = false) => {
    const modal = loadStyle ? this.loadModal : this.saveModal
    if (!modal) return
    modal.textContent = text
    modal.classList.toggle('error', error)
    modal.classList.remove('hidden')
    setTimeout(() => {
      modal.classList.add('show')
    })
    setTimeout(() => {
      modal.classList.remove('show')
    }, error ? 3000 : 1000)

    setTimeout(() => {
      modal.classList.add('hidden')
    }, error ? 3350 : 1350)
  }

  update = () => {
    this.fps.update()
  }
}
