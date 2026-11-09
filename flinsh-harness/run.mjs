#!/usr/bin/env node
/**
 * Verifies the Flinsh build end to end in Chromium (Playwright).
 *
 *   npm run build && npm run test:flinsh
 *
 * Needs a checkout of Flinch next to this repo (or FLINCH_DIR=...), because
 * the harness uses Flinch's real sandbox code (web/src/lib/miniAppSandbox.ts).
 *
 * Scenarios:
 *   sandbox-base    runner CSP as it is today -> expect main-thread fallback
 *   sandbox-worker  runner CSP + worker-src blob: -> expect the worker
 *   standalone      `vite` dev server, top-level page, localStorage saves
 * Each: boot, Play, measure frame times while crossing chunks, place 50
 * blocks with real mouse clicks, Save, reload, Load, check every block is back.
 * Plus (sandbox-worker) save sizes for 50 / 2,000 edits, chunked writes,
 * the quota guard and save coalescing.
 */
import { chromium } from 'playwright'
import { build } from 'esbuild'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const FLINCH = process.env.FLINCH_DIR || path.resolve(repo, '../Flinch')
const PORT = 4317
const DEV_PORT = 5317
const only = process.argv[2]
const headed = !!process.env.HEADED

const sandboxJs = (
  await build({
    entryPoints: [path.join(FLINCH, 'web/src/lib/miniAppSandbox.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'FlinshSandbox'
  })
).outputFiles[0].text

const server = http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (type, body) => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    if (url.pathname === '/harness.html') return send('text/html', fs.readFileSync(path.join(here, 'harness.html')))
    if (url.pathname === '/sandbox.js') return send('text/javascript', sandboxJs)
    if (url.pathname === '/app.html') return send('text/html', fs.readFileSync(path.join(repo, 'dist/index.html')))
    res.writeHead(404).end()
  })
  .listen(PORT)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = {}
const log = (...a) => console.log(...a)

async function waitFor(fn, what, timeout = 30000, every = 100) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => undefined)
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + what)
    await sleep(every)
  }
}

/** The page (or iframe) the game runs in. */
async function appFrame(page, sandboxed) {
  if (!sandboxed) return page.mainFrame()
  await waitFor(() => page.evaluate(() => window.__harness.ready > 0), 'flinsh.ready()')
  return page.frames().find(f => f !== page.mainFrame())
}

async function gameRect(page, sandboxed) {
  if (!sandboxed) {
    const v = page.viewportSize()
    return { x: 0, y: 0, width: v.width, height: v.height }
  }
  return page.locator('iframe').boundingBox()
}

async function info(app) {
  return app.evaluate(() => {
    const { terrain, look } = window.__mc
    return {
      generatePath: terrain.generator.path,
      fallbackReason: terrain.generator.fallbackReason,
      lookMode: look.mode,
      lookFallbackReason: look.fallbackReason,
      lookActive: look.active,
      hintVisible: !document.querySelector('.look-hint').classList.contains('hidden'),
      backend: window.flinsh ? 'flinsh' : 'standalone',
      embedded: window.top !== window
    }
  })
}

async function waitForGeneration(app, min = 1) {
  await waitFor(() => app.evaluate(n => window.__mc.stats.generations.length >= n, min), 'terrain generation', 60000)
}

async function measureFrames(app) {
  return app.evaluate(async () => {
    const { terrain, control, stats } = window.__mc
    const wait = ms => new Promise(r => setTimeout(r, ms))
    control.player.setMode('flying')
    const start = terrain.camera.position.clone()
    // idle baseline: no generation
    await wait(1500)
    stats.reset()
    await wait(4000)
    const idle = stats.summary()
    // cross 12 chunk borders, one every 700 ms
    stats.reset()
    for (let i = 0; i < 12; i++) {
      terrain.camera.position.x += terrain.chunkSize
      await wait(700)
    }
    await wait(1500)
    const moving = stats.summary()
    const gens = stats.generations.slice()
    terrain.camera.position.copy(start)
    await wait(300)
    return { idle, moving, gens }
  })
}

/** Aim straight down at the ground near (x, z) from a few blocks above. */
async function aimAt(app, x, z) {
  return app.evaluate(
    ([x, z]) => {
      const { terrain, control } = window.__mc
      const n = terrain.noise
      const v = (gap, seed, amp) => n.get(x / gap, z / gap, seed) * amp
      const treeHere =
        v(n.treeGap, n.treeSeed, n.treeAmp) > n.treeThreshold &&
        Math.floor(v(n.gap, n.seed, n.amp)) >= -3 &&
        v(n.stoneGap, n.stoneSeed, n.stoneAmp) < n.stoneThreshold
      if (treeHere) return null
      const surface = 30 + Math.floor(v(n.gap, n.seed, n.amp))
      const cam = terrain.camera
      control.player.setMode('flying')
      control.velocity.set(0, 0, 0)
      cam.position.set(x, surface + 3.4, z)
      cam.rotation.set(-Math.PI / 2 + 1e-4, 0, 0, 'YXZ')
      cam.updateMatrixWorld()
      return surface
    },
    [x, z]
  )
}

async function placeBlocks(page, app, sandboxed, count) {
  const rect = await gameRect(page, sandboxed)
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const placed = []
  let attempts = 0
  for (let i = 0; placed.length < count && attempts < count * 4; i++) {
    attempts++
    const x = 2 + (i % 10) * 2
    const z = 2 + Math.floor(i / 10) * 3
    const surface = await aimAt(app, x, z)
    if (surface === null) continue
    await sleep(60) // let a frame render with the new camera
    const before = await app.evaluate(() => window.__mc.terrain.customBlocks.length)
    await page.mouse.click(cx, cy, { button: 'right' })
    await sleep(40)
    const after = await app.evaluate(() => {
      const b = window.__mc.terrain.customBlocks
      const last = b[b.length - 1]
      return { n: b.length, last: last && { x: last.x, y: last.y, z: last.z, type: last.type, placed: last.placed } }
    })
    if (after.n === before + 1 && after.last.placed) placed.push(after.last)
  }
  return { placed, attempts }
}

async function checkBlocksRendered(app, blocks) {
  return app.evaluate(blocks => {
    const { terrain } = window.__mc
    const missing = blocks.filter(b => {
      const arr = terrain.blocks[b.type].instanceMatrix.array
      const n = terrain.blocksCount[b.type]
      for (let i = 0; i < n; i++) {
        const o = i * 16
        if (arr[o + 12] === b.x && arr[o + 13] === b.y && arr[o + 14] === b.z && arr[o + 15] === 1) return false
      }
      return true
    })
    const saved = terrain.customBlocks.filter(b => b.placed).length
    return { inList: saved, missing: missing.length, position: terrain.camera.position.toArray() }
  }, blocks)
}

async function playToWorld(page, app, sandboxed) {
  const rect = await gameRect(page, sandboxed)
  // click Play with the real mouse (a user gesture, as pointer lock needs)
  const play = await app.locator('#play').boundingBox()
  await page.mouse.click(play.x + play.width / 2, play.y + play.height / 2)
  await waitFor(() => app.evaluate(() => window.__mc.look.active), 'game to start', 5000)
  await waitForGeneration(app)
  return rect
}

async function scenario(name, { url, sandboxed }) {
  log(`\n=== ${name} ===`)
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--enable-unsafe-swiftshader']
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const consoleLines = []
  page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`))
  const r = { name }
  try {
    await page.goto(url)
    if (sandboxed) await page.evaluate(() => window.__store.clear())
    else await page.evaluate(() => localStorage.clear())
    if (!sandboxed) await page.reload()
    let app = await appFrame(page, sandboxed)
    await waitFor(() => app.evaluate(() => !!window.__mc), 'app boot')
    r.webgl = await app.evaluate(() => {
      const gl = document.querySelector('canvas').getContext('webgl2') || document.querySelector('canvas').getContext('webgl')
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info')
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'
    })
    if (sandboxed) r.readyCalls = await page.evaluate(() => window.__harness.ready)

    await playToWorld(page, app, sandboxed)
    r.afterPlay = await info(app)
    log('after Play:', r.afterPlay)

    // frame times
    const f = await measureFrames(app)
    r.frames = { idle: f.idle, moving: f.moving }
    r.generations = f.gens
    log('idle  :', JSON.stringify(f.idle))
    log('moving:', JSON.stringify(f.moving))
    await waitForGeneration(app)

    // 50 blocks with real right-clicks on the canvas
    const { placed, attempts } = await placeBlocks(page, app, sandboxed, 50)
    r.placed = placed.length
    r.placeAttempts = attempts
    log(`placed ${placed.length} blocks in ${attempts} clicks`)
    await page.screenshot({ path: path.join(here, `shot-${name}-placed.png`) })

    // pause and Save and Exit
    const lookMode = (await info(app)).lookMode
    if (lookMode === 'pointer') await app.evaluate(() => window.__mc.look.unlock())
    else await page.keyboard.press('e')
    await waitFor(() => app.evaluate(() => !window.__mc.look.active), 'pause', 5000)
    const saveLabel = await app.locator('#save').innerText()
    await app.locator('#save').click()
    r.saveReport = await waitFor(() => app.evaluate(() => window.__mc.ui.world.lastReport), 'save', 15000)
    r.saveToast = await app.locator('.save-modal').innerText()
    log(`"${saveLabel}" ->`, r.saveToast, JSON.stringify(r.saveReport))
    if (sandboxed) {
      r.storeAfterSave = await page.evaluate(() => ({ keys: window.__store.dump(), usage: window.__store.usage(), errors: window.__harness.errors }))
      log('store:', JSON.stringify(r.storeAfterSave))
    }
    const posBefore = await app.evaluate(() => window.__mc.terrain.camera.position.toArray())

    // reload everything, then Load Game
    await page.reload()
    app = await appFrame(page, sandboxed)
    await waitFor(() => app.evaluate(() => !!window.__mc), 'app boot after reload')
    const loadLabel = await app.locator('#save').innerText()
    const load = await app.locator('#save').boundingBox()
    await page.mouse.click(load.x + load.width / 2, load.y + load.height / 2)
    await waitFor(() => app.evaluate(() => window.__mc.look.active), 'game to resume', 5000)
    await waitForGeneration(app)
    await sleep(300)
    r.afterLoad = await checkBlocksRendered(app, placed)
    // x/z exact; y may only have dropped (a walking player lands on the ground)
    const [x0, y0, z0] = posBefore
    const [x1, y1, z1] = r.afterLoad.position
    r.positionRestored = x0 === x1 && z0 === z1 && y1 <= y0 + 1e-6 && y0 - y1 < 5
    r.loadPath = await info(app)
    log(`"${loadLabel}" ->`, JSON.stringify(r.afterLoad), 'position restored:', r.positionRestored)
    await page.screenshot({ path: path.join(here, `shot-${name}-loaded.png`) })
    r.pass = r.placed === 50 && r.afterLoad.inList === 50 && r.afterLoad.missing === 0 && r.positionRestored

    if (name === 'sandbox-worker') r.storage = await storageTests(page, app)
  } catch (e) {
    r.error = e.message
    log('ERROR', e.message)
    await page.screenshot({ path: path.join(here, `shot-${name}-error.png`) }).catch(() => {})
  } finally {
    r.console = consoleLines.filter(l => !/Download the React|GPU stall/.test(l)).slice(0, 40)
    results[name] = r
    await browser.close()
  }
}

/** Save sizes, chunked writes, quota guard and coalescing, through the real bridge. */
async function storageTests(page, app) {
  const out = {}
  const callsSince = n => page.evaluate(n => window.__harness.calls.slice(n), n)
  const callCount = () => page.evaluate(() => window.__harness.calls.length)

  // realistic edit records: x/z within a few hundred blocks, mixed types, ~1/3 removals
  const setEdits = (n, seed = 1) =>
    app.evaluate(
      ([n, seed]) => {
        let s = seed
        const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
        const { terrain } = window.__mc
        const Block = terrain.customBlocks[0].constructor
        const list = []
        for (let i = 0; i < n; i++) {
          list.push(new Block(Math.round(rnd() * 600 - 300), Math.round(10 + rnd() * 35), Math.round(rnd() * 600 - 300), Math.floor(rnd() * 11), rnd() > 0.33))
        }
        terrain.customBlocks = list
      },
      [n, seed]
    )
  const flush = () => app.evaluate(() => window.__mc.ui.world.flush().then(r => r, e => ({ error: e.message })))

  // 50 edits as placed in the game are in the store already; record sizes for 2,000 synthetic
  await setEdits(2000)
  out.edits2000 = await flush()
  out.store2000 = await page.evaluate(() => ({ keys: window.__store.dump(), usage: window.__store.usage() }))

  // chunking: 20,000 edits -> several 128 KB chunks
  await setEdits(20000)
  out.edits20000 = await flush()
  // flip one early record in place -> only chunk 0 rewritten
  await app.evaluate(() => (window.__mc.terrain.customBlocks[0].placed = !window.__mc.terrain.customBlocks[0].placed))
  let n0 = await callCount()
  out.flipOne = await flush()
  out.flipOneCalls = (await callsSince(n0)).map(c => `${c.op} ${c.key}`)
  // append -> only the last chunk
  await app.evaluate(() => {
    const t = window.__mc.terrain
    const B = t.customBlocks[0].constructor
    for (let i = 0; i < 10; i++) t.customBlocks.push(new B(i, 40, i, 0, true))
  })
  n0 = await callCount()
  out.append = await flush()
  out.appendCalls = (await callsSince(n0)).map(c => `${c.op} ${c.key}`)
  // shrink -> stale chunk keys deleted
  await setEdits(2000)
  n0 = await callCount()
  out.shrink = await flush()
  out.shrinkCalls = (await callsSince(n0)).map(c => `${c.op} ${c.key}`)
  // too big for the 2 MB quota -> clear error, nothing half-written
  await setEdits(160000)
  out.tooBig = await flush()

  // reload round trip of 20,000 edits through chunks
  await setEdits(20000, 7)
  await flush()
  const expected = await app.evaluate(() => window.__mc.ui.snapshot().blocks.map(b => `${b.x},${b.y},${b.z},${b.type},${b.placed}`).join(';'))
  await page.reload()
  app = await appFrame(page, true)
  await waitFor(() => app.evaluate(() => !!window.__mc), 'boot')
  const got = await app.evaluate(() => window.__mc.ui.world.load().then(s => s.blocks.map(b => `${b.x},${b.y},${b.z},${b.type},${b.placed}`).join(';')))
  out.roundTrip20000 = got === expected

  // coalescing: 30 edits within ~1.5 s while playing a saved world -> one save
  const play = await app.locator('#save').boundingBox() // Load Game
  await page.mouse.click(play.x + play.width / 2, play.y + play.height / 2)
  await waitFor(() => app.evaluate(() => window.__mc.look.active), 'resume')
  await sleep(500)
  n0 = await callCount()
  await app.evaluate(async () => {
    const { terrain } = window.__mc
    const B = terrain.customBlocks[0].constructor
    for (let i = 0; i < 30; i++) {
      terrain.customBlocks.push(new B(1000 + i, 40, 0, 0, true))
      terrain.markEdited()
      await new Promise(r => setTimeout(r, 50))
    }
  })
  await sleep(3000)
  const calls = await callsSince(n0)
  out.coalesce = { edits: 30, setCalls: calls.filter(c => c.op === 'set').map(c => c.key) }
  log('storage:', JSON.stringify(out, null, 1))
  return out
}

/** Frame times while crossing chunks, per path, render distance and CPU speed. */
async function perf() {
  const rows = []
  for (const throttle of [1, 4]) {
    for (const distance of [3, 6]) {
      for (const variant of ['worker', 'base']) {
        const browser = await chromium.launch({ headless: !headed, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] })
        const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
        try {
          await page.goto(`http://localhost:${PORT}/harness.html?csp=${variant}`)
          await page.evaluate(() => window.__store.clear())
          const app = await appFrame(page, true)
          await waitFor(() => app.evaluate(() => !!window.__mc), 'boot')
          await playToWorld(page, app, true)
          await app.evaluate(d => {
            // what the Settings "Apply" button does
            const t = window.__mc.terrain
            t.distance = d
            t.maxCount = (t.distance * t.chunkSize * 2 + t.chunkSize) ** 2 + 500
            t.initBlocks()
            t.generate()
          }, distance)
          await waitForGeneration(app, 2)
          const cdp = await page.context().newCDPSession(page)
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
          const f = await measureFrames(app)
          const path = await app.evaluate(() => window.__mc.terrain.generator.path)
          const m = f.moving
          const row = {
            path, distance, cpuThrottle: throttle,
            p50: +m.frameP50.toFixed(1), p95: +m.frameP95.toFixed(1), p99: +m.frameP99.toFixed(1), max: +m.frameMax.toFixed(1),
            over33: m.framesOver33ms, frames: m.frames,
            idleP95: +f.idle.frameP95.toFixed(1),
            genCompute: +m.genComputeAvg.toFixed(1), genWall: +m.genWallAvg.toFixed(1), slices: +m.genSlicesAvg.toFixed(1), gens: m.generations
          }
          rows.push(row)
          log(JSON.stringify(row))
        } catch (e) {
          log('perf error', variant, distance, throttle, e.message)
        } finally {
          await browser.close()
        }
      }
    }
  }
  results.perf = rows
  console.table(rows)
}

/** With allow-pointer-lock granted, the game should use real pointer lock. */
async function pointerLockGranted() {
  const browser = await chromium.launch({ headless: !headed })
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  try {
    await page.goto(`http://localhost:${PORT}/harness.html?csp=worker&sandbox=${encodeURIComponent('allow-scripts allow-pointer-lock')}`)
    const app = await appFrame(page, true)
    await waitFor(() => app.evaluate(() => !!window.__mc), 'boot')
    await playToWorld(page, app, true)
    await sleep(500)
    results.pointerLockGranted = await app.evaluate(() => ({
      lookMode: window.__mc.look.mode,
      locked: !!document.pointerLockElement,
      active: window.__mc.look.active
    }))
  } catch (e) {
    results.pointerLockGranted = { error: e.message }
  } finally {
    await browser.close()
  }
  log('allow-pointer-lock:', JSON.stringify(results.pointerLockGranted))
}

/** Phone: layout in portrait/landscape, then touch play, inside the sandbox. */
async function mobile() {
  const out = {}
  const { devices } = await import('playwright')
  for (const [label, landscape] of [['portrait', false], ['landscape', true]]) {
    const dev = devices[landscape ? 'iPhone 13 landscape' : 'iPhone 13']
    const browser = await chromium.launch({ headless: !headed, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] })
    // Chromium with an iPhone profile: same viewport, touch and UA, not Safari
    const context = await browser.newContext({ ...dev, defaultBrowserType: undefined })
    const page = await context.newPage()
    const r = (out[label] = { viewport: dev.viewport })
    try {
      await page.goto(`http://localhost:${PORT}/harness.html?csp=worker`)
      await page.evaluate(() => window.__store.clear())
      const app = await appFrame(page, true)
      await waitFor(() => app.evaluate(() => !!window.__mc), 'boot')
      const fits = sel =>
        app.evaluate(sel => {
          const vw = innerWidth, vh = innerHeight
          return [...document.querySelectorAll(sel)]
            .filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed')
            .filter(e => getComputedStyle(e).display !== 'none' && !e.closest('.hidden'))
            .map(e => {
              const b = e.getBoundingClientRect()
              return { id: e.id || e.className, inside: b.left >= 0 && b.top >= 0 && b.right <= vw + 0.5 && b.bottom <= vh + 0.5, h: Math.round(b.height), w: Math.round(b.width) }
            })
        }, sel)
      r.frame = await app.evaluate(() => [innerWidth, innerHeight])
      r.menuButtons = await fits('.menu .button')
      await page.screenshot({ path: path.join(here, `shot-mobile-${label}-menu.png`) })
      await app.locator('#setting').tap()
      r.settings = await fits('.settings')
      await page.screenshot({ path: path.join(here, `shot-mobile-${label}-settings.png`) })
      await app.locator('#setting-back').tap()

      await app.locator('#play').tap()
      await waitFor(() => app.evaluate(() => window.__mc.look.active), 'play')
      await waitForGeneration(app)
      r.lookMode = await app.evaluate(() => window.__mc.look.mode)
      r.joystick = await fits('.joystick-button, .joystick-menu')
      const rect = await gameRect(page, true)
      const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2

      // tap = place a block (aimed at the ground)
      await aimAt(app, 4, 4) ?? (await aimAt(app, 6, 8))
      await sleep(80)
      const n0 = await app.evaluate(() => window.__mc.terrain.customBlocks.length)
      await page.touchscreen.tap(cx, cy)
      await sleep(150)
      r.tapPlaced = (await app.evaluate(() => window.__mc.terrain.customBlocks.length)) - n0

      // swipe = look around
      const cdp = await context.newCDPSession(page)
      const q0 = await app.evaluate(() => window.__mc.terrain.camera.quaternion.toArray())
      const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
      await touch('touchStart', cx, cy)
      for (let i = 1; i <= 10; i++) await touch('touchMove', cx + i * 12, cy)
      await touch('touchEnd')
      const q1 = await app.evaluate(() => window.__mc.terrain.camera.quaternion.toArray())
      r.swipeRotated = q0.some((v, i) => Math.abs(v - q1[i]) > 1e-3)

      // hold the forward arrow = walk
      await app.evaluate(() => window.__mc.control.player.setMode('walking'))
      const p0 = await app.evaluate(() => window.__mc.terrain.camera.position.toArray())
      const front = await app.locator('#action-front').boundingBox()
      await touch('touchStart', front.x + front.width / 2, front.y + front.height / 2)
      await sleep(1000)
      await touch('touchEnd')
      const p1 = await app.evaluate(() => window.__mc.terrain.camera.position.toArray())
      r.holdForwardMoved = +Math.hypot(p1[0] - p0[0], p1[2] - p0[2]).toFixed(2)
      await page.screenshot({ path: path.join(here, `shot-mobile-${label}-play.png`) })

      // menu button -> pause -> Save and Exit
      await app.locator('#action-menu').tap()
      await waitFor(() => app.evaluate(() => !window.__mc.look.active), 'pause')
      r.pauseMenu = await fits('.menu .button')
      await app.locator('#save').tap()
      r.saved = await waitFor(() => app.evaluate(() => window.__mc.ui.world.lastReport), 'save', 10000)
    } catch (e) {
      r.error = e.message
      await page.screenshot({ path: path.join(here, `shot-mobile-${label}-error.png`) }).catch(() => {})
    } finally {
      await browser.close()
    }
    log(label, JSON.stringify(r))
  }
  results.mobile = out
}

let dev
try {
  if (only === 'mobile') await mobile()
  if (only === 'perf') await perf()
  if (!only || only === 'pointerlock') await pointerLockGranted()
  if (!only || only === 'sandbox-base') {
    await scenario('sandbox-base', { url: `http://localhost:${PORT}/harness.html?csp=base`, sandboxed: true })
  }
  if (!only || only === 'sandbox-worker') {
    await scenario('sandbox-worker', { url: `http://localhost:${PORT}/harness.html?csp=worker`, sandboxed: true })
  }
  if (!only || only === 'standalone') {
    dev = spawn('npx', ['vite', '--port', String(DEV_PORT), '--strictPort'], { cwd: repo, stdio: 'pipe' })
    await waitFor(() => fetch(`http://localhost:${DEV_PORT}/`).then(r => r.ok), 'vite dev server', 30000, 300)
    await scenario('standalone', { url: `http://localhost:${DEV_PORT}/`, sandboxed: false })
  }
} finally {
  dev?.kill()
  server.close()
  const file = path.join(here, only === 'perf' || only === 'mobile' ? only + '.json' : 'results.json')
  fs.writeFileSync(file, JSON.stringify(results, null, 2))
  log('\nresults written to flinsh-harness/' + path.basename(file))
  for (const [k, v] of Object.entries(results)) {
    if ('pass' in v) log(`${k}: ${v.pass ? 'PASS' : 'FAIL'}${v.error ? ' (' + v.error + ')' : ''}`)
  }
}
