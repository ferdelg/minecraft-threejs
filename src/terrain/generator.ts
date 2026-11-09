import Noise from './noise'

/**
 * Terrain generation, shared by the Web Worker and the main-thread fallback.
 *
 * It is a generator function that yields after every column of x, so the
 * main-thread fallback can run it in small time slices between frames, while
 * the worker simply runs it to completion. It deliberately does not import
 * three.js: it writes instance matrices straight into Float32Arrays (a
 * translation matrix is the identity with x/y/z at elements 12/13/14), which
 * keeps the worker bundle a few KB instead of half a megabyte.
 */

// keep in sync with BlockType in ./index.ts (not imported, to keep three out)
const enum T {
  grass = 0,
  sand = 1,
  tree = 2,
  leaf = 3,
  dirt = 4,
  stone = 5,
  coal = 6
}

export interface GenerateBlock {
  x: number
  y: number
  z: number
  type: number
  placed: boolean
}

export interface GenerateParams {
  distance: number
  chunk: { x: number; y: number }
  noiseSeed: number
  treeSeed: number
  stoneSeed: number
  coalSeed: number
  leafSeed: number
  blocksFactor: number[]
  blocksCount: number[]
  customBlocks: GenerateBlock[]
  chunkSize: number
}

export interface GenerateResult {
  /** position key -> instance id; not sent back from the worker */
  idMap?: Map<string, number>
  arrays: Float32Array[]
  blocksCount: number[]
}

const noise = new Noise()

export function* generateTerrain(
  p: GenerateParams
): Generator<void, GenerateResult, void> {
  const { distance, chunk, blocksFactor, customBlocks, chunkSize } = p
  const blocksCount = p.blocksCount.slice()
  const idMap = new Map<string, number>()
  const maxCount = (distance * chunkSize * 2 + chunkSize) ** 2 + 500

  noise.seed = p.noiseSeed
  noise.treeSeed = p.treeSeed
  noise.stoneSeed = p.stoneSeed
  noise.coalSeed = p.coalSeed
  noise.leafSeed = p.leafSeed

  const arrays = blocksFactor.map(f => new Float32Array(maxCount * f * 16))

  const put = (type: number, x: number, y: number, z: number) => {
    const a = arrays[type]
    const o = blocksCount[type]++ * 16
    if (o + 16 > a.length) return
    a[o] = 1
    a[o + 5] = 1
    a[o + 10] = 1
    a[o + 15] = 1
    a[o + 12] = x
    a[o + 13] = y
    a[o + 14] = z
  }
  const record = (type: number, x: number, y: number, z: number) => {
    idMap.set(`${x}_${y}_${z}`, blocksCount[type])
    put(type, x, y, z)
  }

  const xMin = -chunkSize * distance + chunkSize * chunk.x
  const xMax = chunkSize * distance + chunkSize + chunkSize * chunk.x
  const zMin = -chunkSize * distance + chunkSize * chunk.y
  const zMax = chunkSize * distance + chunkSize + chunkSize * chunk.y

  for (let x = xMin; x < xMax; x++) {
    for (let z = zMin; z < zMax; z++) {
      const y = 30
      const yOffset = Math.floor(
        noise.get(x / noise.gap, z / noise.gap, noise.seed) * noise.amp
      )
      const stoneOffset =
        noise.get(x / noise.stoneGap, z / noise.stoneGap, noise.stoneSeed) *
        noise.stoneAmp
      const coalOffset =
        noise.get(x / noise.coalGap, z / noise.coalGap, noise.coalSeed) *
        noise.coalAmp

      if (stoneOffset > noise.stoneThreshold) {
        record(coalOffset > noise.coalThreshold ? T.coal : T.stone, x, y + yOffset, z)
      } else {
        record(yOffset < -3 ? T.sand : T.grass, x, y + yOffset, z)
      }

      // tree
      const treeOffset =
        noise.get(x / noise.treeGap, z / noise.treeGap, noise.treeSeed) *
        noise.treeAmp

      if (
        treeOffset > noise.treeThreshold &&
        yOffset >= -3 &&
        stoneOffset < noise.stoneThreshold
      ) {
        for (let i = 1; i <= noise.treeHeight; i++) {
          record(T.tree, x, y + yOffset + i, z)
        }

        // leaf
        for (let i = -3; i < 3; i++) {
          for (let j = -3; j < 3; j++) {
            for (let k = -3; k < 3; k++) {
              if (i === 0 && k === 0) continue
              const leafOffset =
                noise.get(
                  (x + i + j) / noise.leafGap,
                  (z + k) / noise.leafGap,
                  noise.leafSeed
                ) * noise.leafAmp
              if (leafOffset > noise.leafThreshold) {
                record(T.leaf, x + i, y + yOffset + noise.treeHeight + j, z + k)
              }
            }
          }
        }
      }
    }
    yield
  }

  for (const block of customBlocks) {
    if (
      block.x > xMin &&
      block.x < xMax &&
      block.z > zMin &&
      block.z < zMax
    ) {
      if (block.placed) {
        // placed blocks
        put(block.type, block.x, block.y, block.z)
      } else {
        // removed blocks: zero the natural block's matrix
        const id = idMap.get(`${block.x}_${block.y}_${block.z}`)
        if (id !== undefined) arrays[block.type].fill(0, id * 16, id * 16 + 16)
      }
    }
  }

  return { idMap, arrays, blocksCount }
}

/** Run a generation to completion (used by the worker). */
export function generateAll(p: GenerateParams): GenerateResult {
  const it = generateTerrain(p)
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
  }
}
