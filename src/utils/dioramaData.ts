import * as THREE from 'three'

export const BLOCK_SIZE = 5.4
export const BLOCK_HALF_SIZE = BLOCK_SIZE * 0.5 // 2.7
export const BLOCK_CORNER_RADIUS = 0.68
export const DEFAULT_WATER_LEVEL = 1.48
export const BASE_BOTTOM_Y = 0.0
export const BASE_SAND_HEIGHT = 0.28

// Deterministic 2D hash & value noise for procedural terrain, strata, and scattering
export function hash2D(x: number, z: number): number {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123
  return h - Math.floor(h)
}

export function valueNoise2D(x: number, z: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz

  const ux = fx * fx * (3.0 - 2.0 * fx)
  const uz = fz * fz * (3.0 - 2.0 * fz)

  const a = hash2D(ix, iz)
  const b = hash2D(ix + 1, iz)
  const c = hash2D(ix, iz + 1)
  const d = hash2D(ix + 1, iz + 1)

  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz
}

export function fbm2D(x: number, z: number, octaves = 4): number {
  let value = 0.0
  let amplitude = 0.5
  let freq = 1.0
  let maxAmp = 0.0

  for (let i = 0; i < octaves; i++) {
    const rx = x * freq * 0.866 - z * freq * 0.5
    const rz = x * freq * 0.5 + z * freq * 0.866
    value += amplitude * (valueNoise2D(rx, rz) * 2.0 - 1.0)
    maxAmp += amplitude
    freq *= 2.07
    amplitude *= 0.5
  }
  return value / maxAmp
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0.0, Math.min(1.0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3.0 - 2.0 * t)
}

/**
 * Signed distance to the rounded-square resin block footprint in XZ plane.
 * Negative inside the block, 0 on the boundary, positive outside.
 */
export function roundedBoxSDF2D(
  x: number,
  z: number,
  halfSize = BLOCK_HALF_SIZE,
  radius = BLOCK_CORNER_RADIUS
): number {
  const b = halfSize - radius
  const qx = Math.abs(x) - b
  const qz = Math.abs(z) - b
  const ox = Math.max(qx, 0.0)
  const oz = Math.max(qz, 0.0)
  return Math.hypot(ox, oz) + Math.min(Math.max(qx, qz), 0.0) - radius
}

/**
 * Maps normalized square coordinates (u, v in [-1, 1]) onto the exact
 * rounded-square footprint so grid vertices align cleanly with the curved border.
 */
export function mapSquareToRoundedBox(
  u: number,
  v: number,
  halfSize = BLOCK_HALF_SIZE,
  radius = BLOCK_CORNER_RADIUS
): [number, number] {
  const x = u * halfSize
  const z = v * halfSize
  const b = halfSize - radius
  const ax = Math.abs(x)
  const az = Math.abs(z)

  if (ax > b && az > b) {
    const dx = ax - b
    const dz = az - b
    const maxD = Math.max(dx, dz)
    const len = Math.hypot(dx, dz)
    if (len > 1e-6) {
      const scale = maxD / len
      return [
        Math.sign(x) * (b + dx * scale),
        Math.sign(z) * (b + dz * scale),
      ]
    }
  }
  return [x, z]
}

export interface TerrainSample {
  /** Solid island + seabed elevation */
  height: number
  /** Sandy seabed floor height (used underneath the resin water volume) */
  seabedHeight: number
  /** 0..1 mask indicating sandy beach cove vs limestone cliff */
  beachMask: number
  /** 0..1 mask indicating how deep inside the solid cliff footprint this point is */
  cliffCoreMask: number
  /** Signed distance to the rounded-square block perimeter */
  boxSdf: number
}

/**
 * Evaluates the procedural island & seabed heightfield at world (x, z).
 * Note: Camera looks from (+11.6, +10.5, +11.6) toward (0, 1.15, 0):
 * - Top-center of screen (back corner) is (-X, -Z)
 * - Left of screen is (-X, +Z)
 * - Right of screen is (+X, -Z)
 * - Bottom-center of screen (front corner) is (+X, +Z)
 *
 * Matching the reference photo:
 * The island landmass sits along the back-left (-X) side of the block, with a high
 * forested limestone bluff on the back-left, a narrower Kelingking-style ridged
 * peninsula extending toward the left-front (-X, +Z), a rocky headland on the
 * back-center (-X*0.2, -Z), and a wide, sunlit crescent sandy beach nestled in the cove!
 */
export function sampleTerrain(x: number, z: number): TerrainSample {
  const boxSdf = roundedBoxSDF2D(x, z)

  // 1. Gently undulating sandy seabed across the block (shallower near the beach, deeper toward +X)
  const distFromCove = Math.hypot(x + 1.25, z + 0.65)
  const seabedSlope = smoothstep(0.5, 4.3, distFromCove)
  const sandRipple =
    Math.sin(x * 3.8 + z * 2.7 + fbm2D(x * 1.1, z * 1.1, 2) * 1.6) * 0.022
  const seabedN = fbm2D(x * 0.65 + 4.1, z * 0.65 - 2.3, 3) * 0.075
  let seabedHeight = 1.06 - seabedSlope * 0.66 + seabedN + sandRipple
  seabedHeight = Math.max(BASE_SAND_HEIGHT + 0.08, Math.min(1.24, seabedHeight))

  // 2. Asymmetric Kelingking-inspired Island Landmass on the Back-Left (-X, -Z to -X, +Z):
  const cragNoise = fbm2D(x * 1.85, z * 1.85, 4) * 0.21
  const fineCrag = fbm2D(x * 4.2 + 7.2, z * 4.2 - 5.1, 3) * 0.085

  // Main bluff anchored on the back-left edge around (-2.25, -1.55)
  const dMainBluff = Math.hypot((x + 2.25) / 2.75, (z + 1.55) / 2.85)
  // Left peninsula ridge spine extending toward (-2.05, +1.05)
  const dLeftPeninsula = Math.hypot((x + 2.10) / 0.86, (z - 0.35) / 1.48)
  // Back-right headland arm reaching toward (+0.45, -2.05)
  const dRightHeadland = Math.hypot((x + 0.35) / 1.55, (z + 2.12) / 0.86)

  let islandField = Math.min(dMainBluff, Math.min(dLeftPeninsula, dRightHeadland))

  // Carve the asymmetric crescent bay cove facing (+X, +Z*0.4)
  const bayDx = x + 0.52
  const bayDz = z + 0.18
  const bayDist = Math.hypot(bayDx * 0.95, bayDz * 0.85)
  const bayCarve = smoothstep(1.48, 0.22, bayDist) * 0.52

  islandField = islandField + bayCarve - cragNoise - fineCrag

  // Steep limestone cliff mask:
  // islandField < 0.78 -> forested summit & ridge spine
  // islandField in [0.78, 1.02] -> steep stratified limestone cliff wall
  const cliffCoreMask = smoothstep(1.02, 0.76, islandField)

  // Natural summit height profile:
  // Highest on the back-left main bluff (~2.95..3.22), sloping down naturally along the left peninsula (~2.45)
  // and right headland (~2.55), matching the proportional height in the reference photo!
  const mainPeak = Math.exp(-((x + 1.85) ** 2 + (z + 1.35) ** 2) * 0.32) * 0.56
  const peninsulaTaper = smoothstep(1.2, -0.8, z) * 0.22
  const ridgeUndulation = fbm2D(x * 1.25 - 1.7, z * 1.25 + 2.4, 4) * 0.24
  const summitHeight = 2.48 + mainPeak + peninsulaTaper + ridgeUndulation

  // Keep the back-left outer perimeter flush with the rounded-square resin block wall
  const edgeTaper = smoothstep(0.02, -0.035, boxSdf)
  const cliffHeight =
    seabedHeight + (summitHeight - seabedHeight) * Math.pow(cliffCoreMask, 0.62) * edgeTaper

  // 3. Generous Sunlit Crescent Sandy Beach ("一弯沙滩") nestled at the foot of the bay cliff!
  // Extends well out from the cliff base (islandField in [0.80, 1.58]) so a wide golden-cream
  // crescent of dry and wet sand is clearly visible above waterLevel (1.48)!
  const inBayCove =
    smoothstep(1.82, 0.45, Math.hypot(x + 0.68, z + 0.28)) *
    smoothstep(-2.15, -1.35, x) *
    smoothstep(-2.05, -1.15, z)

  const beachBand =
    smoothstep(0.76, 0.94, islandField) *
    smoothstep(1.62, 1.06, islandField) *
    inBayCove

  // Dry beach sand rises up to y = 1.78 against the cliff base and slopes gently across waterLevel (1.48)
  const beachSlopeProgress = smoothstep(1.58, 0.85, islandField)
  const beachSurfaceY =
    1.22 + beachSlopeProgress * 0.56 + fbm2D(x * 2.4, z * 2.4, 2) * 0.018

  const combinedSeabedAndBeach =
    seabedHeight + Math.max(0.0, beachSurfaceY - seabedHeight) * beachBand

  const height = Math.max(cliffHeight, combinedSeabedAndBeach)

  // Beach mask is 1.0 on the gently sloping sandy cove where cliffCoreMask is low
  const beachMask = Math.max(
    0.0,
    Math.min(1.0, beachBand * smoothstep(0.52, 0.10, cliffCoreMask))
  )

  return {
    height,
    seabedHeight: combinedSeabedAndBeach,
    beachMask,
    cliffCoreMask,
    boxSdf,
  }
}

export const sampleDioramaTerrain = sampleTerrain

export interface RockInstanceData {
  position: [number, number, number]
  scale: [number, number, number]
  rotation: [number, number, number]
  isEmerging: boolean
  /** True if the rock breaks or sits right at the water surface and should generate shore foam */
  isCoastal: boolean
  seed: number
}

/**
 * Generates procedural boulders:
 * 1. Emerging & awash limestone boulders clustered at the left & right bay headlands (breaking the surf)
 * 2. Natural scattered reef rocks resting on the turquoise sandy seabed inside the resin block
 */
export function generateRocksData(): RockInstanceData[] {
  const rocks: RockInstanceData[] = []

  // Group A: Emerging/awash coastal boulders at the headlands & beach ends
  const coastalSpecs: Array<{
    u: number
    v: number
    sx: number
    sy: number
    sz: number
    yOffset: number
  }> = [
    // Left peninsula tip & headland rocks
    { u: -0.66, v: 0.42, sx: 0.28, sy: 0.20, sz: 0.24, yOffset: 0.03 },
    { u: -0.54, v: 0.46, sx: 0.22, sy: 0.16, sz: 0.20, yOffset: -0.02 },
    { u: -0.44, v: 0.36, sx: 0.18, sy: 0.14, sz: 0.17, yOffset: -0.04 },
    { u: -0.74, v: 0.30, sx: 0.24, sy: 0.19, sz: 0.21, yOffset: 0.04 },
    // Right headland cluster framing the other end of the crescent beach
    { u: 0.02, v: -0.58, sx: 0.27, sy: 0.20, sz: 0.24, yOffset: 0.03 },
    { u: 0.14, v: -0.52, sx: 0.21, sy: 0.15, sz: 0.19, yOffset: -0.03 },
    { u: -0.08, v: -0.46, sx: 0.18, sy: 0.13, sz: 0.16, yOffset: -0.05 },
  ]

  coastalSpecs.forEach((spec, idx) => {
    const [x, z] = mapSquareToRoundedBox(spec.u, spec.v)
    const y = DEFAULT_WATER_LEVEL + spec.yOffset
    rocks.push({
      position: [x, y, z],
      scale: [spec.sx, spec.sy, spec.sz],
      rotation: [
        hash2D(idx, 1.1) * 0.4,
        hash2D(idx, 2.2) * Math.PI * 2,
        hash2D(idx, 3.3) * 0.4,
      ],
      isEmerging: true,
      isCoastal: true,
      seed: idx + 1,
    })
  })

  // Group B: Submerged seabed boulders & reef rocks scattered naturally on the sandy floor
  const submergedSpecs: Array<{
    u: number
    v: number
    sx: number
    sy: number
    sz: number
  }> = [
    // Foreground shallow-mid turquoise floor rocks (matching reference photo!)
    { u: 0.12, v: 0.58, sx: 0.34, sy: 0.16, sz: 0.26 },
    { u: 0.38, v: 0.46, sx: 0.22, sy: 0.13, sz: 0.19 },
    { u: -0.22, v: 0.64, sx: 0.25, sy: 0.14, sz: 0.21 },
    { u: 0.56, v: 0.18, sx: 0.32, sy: 0.17, sz: 0.26 },
    { u: 0.62, v: -0.18, sx: 0.26, sy: 0.14, sz: 0.22 },
    { u: 0.36, v: -0.32, sx: 0.20, sy: 0.12, sz: 0.18 },
  ]

  submergedSpecs.forEach((spec, i) => {
    const idx = i + 20
    const [x, z] = mapSquareToRoundedBox(spec.u, spec.v)
    const t = sampleTerrain(x, z)
    const y = t.seabedHeight + spec.sy * 0.28
    rocks.push({
      position: [x, y, z],
      scale: [spec.sx, spec.sy, spec.sz],
      rotation: [
        (hash2D(idx, 4.1) - 0.5) * 0.35,
        hash2D(idx, 5.2) * Math.PI * 2,
        (hash2D(idx, 6.3) - 0.5) * 0.35,
      ],
      isEmerging: false,
      isCoastal: false,
      seed: idx,
    })
  })

  return rocks
}

export interface VegetationInstanceData {
  position: [number, number, number]
  scale: [number, number, number]
  rotation: [number, number, number]
  colorTint: [number, number, number]
}

/**
 * Generates dense, multi-tiered tropical forest canopy clusters across the cliff summit,
 * ridge spine, and cascading ledges.
 */
export function generateVegetationData(): VegetationInstanceData[] {
  const instances: VegetationInstanceData[] = []
  const gridSteps = 38
  const eps = 0.05

  // Deep, rich tropical rainforest palette (matching the dark emerald & olive foliage in the reference photo)
  const palette: Array<[number, number, number]> = [
    [0.06, 0.16, 0.04], // deep rainforest shadow green
    [0.09, 0.20, 0.05], // dark tropical emerald
    [0.13, 0.24, 0.06], // rich mid foliage green
    [0.17, 0.28, 0.08], // warm olive canopy
    [0.22, 0.33, 0.09], // sunlit crown green
  ]

  for (let iu = 0; iu < gridSteps; iu++) {
    for (let iv = 0; iv < gridSteps; iv++) {
      const u = -0.96 + (iu / (gridSteps - 1)) * 1.92
      const v = -0.96 + (iv / (gridSteps - 1)) * 1.92

      const jx = (hash2D(iu * 3.1, iv * 5.7) - 0.5) * 0.048
      const jz = (hash2D(iu * 7.3, iv * 2.9) - 0.5) * 0.048

      const [x, z] = mapSquareToRoundedBox(
        Math.max(-0.96, Math.min(0.96, u + jx)),
        Math.max(-0.96, Math.min(0.96, v + jz))
      )

      const s = sampleTerrain(x, z)
      if (s.boxSdf > -0.12) continue

      const hx = sampleTerrain(x + eps, z).height - sampleTerrain(x - eps, z).height
      const hz = sampleTerrain(x, z + eps).height - sampleTerrain(x, z - eps).height
      const slope = Math.hypot(hx, hz) / (2.0 * eps)

      // 1. Dense continuous forest blanket on the cliff summit & ridge spine
      const isSummitCanopy = s.cliffCoreMask > 0.52 && s.height > 2.02 && slope < 3.6
      // 2. Cascading vegetation pockets clinging to cliff ledges
      const ledgeBand = Math.sin(s.height * 11.5 + fbm2D(x * 3.2, z * 3.2, 2) * 2.2)
      const isCliffLedgeShrub =
        s.cliffCoreMask > 0.20 &&
        s.cliffCoreMask <= 0.56 &&
        s.height > 1.72 &&
        slope < 4.6 &&
        ledgeBand > 0.32 &&
        hash2D(x * 9.1, z * 9.1) > 0.32

      if (isSummitCanopy || isCliffLedgeShrub) {
        const rand1 = hash2D(x * 13.7, z * 19.3)
        const rand2 = hash2D(x * 29.1, z * 7.7)
        const rand3 = hash2D(x * 41.3, z * 31.9)

        const rimFactor = smoothstep(0.50, 0.92, s.cliffCoreMask)
        const baseRadius = isSummitCanopy
          ? (0.16 + rand1 * 0.17) * (0.76 + 0.46 * rimFactor)
          : 0.10 + rand1 * 0.085
        const heightScale = baseRadius * (0.72 + rand2 * 0.38)

        const colorIdx = Math.min(
          palette.length - 1,
          Math.floor(rand3 * palette.length)
        )
        const baseColor = palette[colorIdx]

        instances.push({
          position: [x, s.height - 0.035, z],
          scale: [baseRadius, heightScale, baseRadius * (0.88 + rand3 * 0.24)],
          rotation: [
            (rand1 - 0.5) * 0.24,
            rand2 * Math.PI * 2,
            (rand3 - 0.5) * 0.24,
          ],
          colorTint: baseColor,
        })
      }
    }
  }

  return instances
}

/**
 * Generates an RGBA Float32 DataTexture encoding:
 * - R: seabed & island terrain height
 * - G: obstacle height for water waves/foam (terrain + coastal emerging boulders ONLY)
 * - B: sandy beach mask (0..1)
 * - A: signed distance to the rounded-square resin block border
 */
export function createTerrainDataTexture(
  rocks: RockInstanceData[],
  resolution = 256
): THREE.DataTexture {
  const data = new Float32Array(resolution * resolution * 4)
  const coastalRocks = rocks.filter((r) => r.isCoastal)

  for (let iy = 0; iy < resolution; iy++) {
    const v = (iy / (resolution - 1)) * 2.0 - 1.0
    for (let ix = 0; ix < resolution; ix++) {
      const u = (ix / (resolution - 1)) * 2.0 - 1.0
      const x = u * BLOCK_HALF_SIZE
      const z = v * BLOCK_HALF_SIZE

      const t = sampleTerrain(x, z)
      let obstacleHeight = t.height

      for (let r = 0; r < coastalRocks.length; r++) {
        const rock = coastalRocks[r]
        const dx = (x - rock.position[0]) / (rock.scale[0] * 1.15)
        const dz = (z - rock.position[2]) / (rock.scale[2] * 1.15)
        const d2 = dx * dx + dz * dz
        if (d2 < 1.0) {
          const sphereH =
            rock.position[1] + Math.sqrt(Math.max(0.0, 1.0 - d2)) * rock.scale[1]
          obstacleHeight = Math.max(obstacleHeight, sphereH)
        }
      }

      const idx = (iy * resolution + ix) * 4
      data[idx + 0] = t.height
      data[idx + 1] = obstacleHeight
      data[idx + 2] = t.beachMask
      data[idx + 3] = t.boxSdf
    }
  }

  const texture = new THREE.DataTexture(
    data,
    resolution,
    resolution,
    THREE.RGBAFormat,
    THREE.FloatType
  )
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}
