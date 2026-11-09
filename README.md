# minecraft-threejs

English ｜ [中文](https://github.com/vyse12138/minecraft-threejs/blob/main/README_ZH.md)

Minecraft clone made with Three.js and TypeScript

Recommend to use Chrome to get the best experience

![preview](https://user-images.githubusercontent.com/88306344/154383952-9b33bad4-eebb-4a98-a12e-f5f137422d06.gif)

## Features:

- Destroy block and place block
- Mouse wheel (or number key) to select different block types
- Movement and collision detection
- Random terrain / blocks / tree generations
- Infinite world
- Game save / load
- Sound effect and BGM
- Highlight the block at crosshair
- Basic UI and settings
- Mobile friendly

## Working on:

- Multiplayer
- Generates water
- Higher performance algorithm

## Flinsh build

This fork also runs as a [Flinsh](flinsh.json) app (`type: "app"`, entrypoint `dist/index.html`).

- `npm run build` produces one self-contained `dist/index.html` (all JS, CSS, textures, fonts and sounds inlined, about 3.5 MB). It is committed because Flinsh serves it straight from the repo.
- Terrain generation runs in a Web Worker started from a Blob URL. If the page's CSP has no `worker-src blob:`, it falls back to generating on the main thread in idle-time slices.
- If pointer lock is refused (a sandboxed iframe without `allow-pointer-lock`), you drag on the canvas to look around. A plain click breaks a block, a right-click places one, and E opens the menu.
- Saves go to `window.flinsh.store` (user scope) when the bridge is present, and to `localStorage` otherwise. The world is stored as a `world/manifest` key plus `world/blocks/NNN` chunks of up to 128 KB. Only changed chunks are rewritten, and once a world has been saved or loaded, edits autosave.
- `npm run test:flinsh` runs the end-to-end checks in Chromium. It needs a Flinch checkout next to this repo, or `FLINCH_DIR`. It loads the build through Flinch's own sandbox code under the runner's CSP, with and without `worker-src blob:`. It then places 50 blocks, saves, reloads and confirms they are back. `npm run test:flinsh perf` compares frame times; `npm run test:flinsh mobile` checks the phone layout and touch input.
