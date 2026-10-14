import { useMemo, useRef, useEffect } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { MeshTransmissionMaterial } from '@react-three/drei'
import {
  BLOCK_HALF_SIZE,
  BLOCK_CORNER_RADIUS,
  BASE_SAND_HEIGHT,
  DEFAULT_WATER_LEVEL,
} from '../utils/dioramaData'
import { JellyUniforms, injectJellyIntoMaterial } from '../utils/jellyShader'

export interface ResinBlockProps {
  waterLevel: number
  waterColor: string
  jellyUniforms: JellyUniforms
  isLowPerf?: boolean
}

function createRoundedSquarePoints(
  halfSize: number,
  radius: number,
  segmentsPerSide = 14
): Array<[number, number, number, number]> {
  const pts: Array<[number, number, number, number]> = []
  const inner = halfSize - radius

  // Generate smooth perimeter points [x, z, nx, nz] around the rounded square
  const cornerCenters: Array<[number, number, number]> = [
    [inner, -inner, -Math.PI / 2], // Back-Right (+X, -Z)
    [inner, inner, 0], // Front-Right (+X, +Z)
    [-inner, inner, Math.PI / 2], // Front-Left (-X, +Z)
    [-inner, -inner, Math.PI], // Back-Left (-X, -Z)
  ]

  const arcSteps = 14
  const edgeSteps = segmentsPerSide

  for (let c = 0; c < 4; c++) {
    const [cx, cz, startAngle] = cornerCenters[c]
    const nextC = cornerCenters[(c + 1) % 4]

    // Corner arc
    for (let i = 0; i < arcSteps; i++) {
      const t = i / arcSteps
      const ang = startAngle + t * (Math.PI / 2)
      const nx = Math.cos(ang)
      const nz = Math.sin(ang)
      pts.push([cx + nx * radius, cz + nz * radius, nx, nz])
    }

    // Straight edge to next corner start
    const endAng = startAngle + Math.PI / 2
    const nx = Math.cos(endAng)
    const nz = Math.sin(endAng)
    const sx = cx + nx * radius
    const sz = cz + nz * radius
    const ex = nextC[0] + nx * radius
    const ez = nextC[1] + nz * radius

    for (let i = 0; i < edgeSteps; i++) {
      const t = i / edgeSteps
      pts.push([sx + (ex - sx) * t, sz + (ez - sz) * t, nx, nz])
    }
  }

  // Close loop
  pts.push([...pts[0]])
  return pts
}

export function ResinBlock({
  waterLevel,
  waterColor,
  jellyUniforms,
}: ResinBlockProps) {
  const matRef = useRef<THREE.MeshPhysicalMaterial>(null)
  const meshRef = useRef<THREE.Mesh>(null)

  // Build an optical rounded-square resin wall with a polished top meniscus bevel lip.
  // Outward counter-clockwise triangle winding ensures front-facing transmission on all visible walls.
  const geometry = useMemo(() => {
    const pts = createRoundedSquarePoints(BLOCK_HALF_SIZE, BLOCK_CORNER_RADIUS, 14)
    const baseDepth = DEFAULT_WATER_LEVEL - BASE_SAND_HEIGHT
    const bevelR = 0.032

    // Vertical profile from bottom (y = 0) up to top meniscus lip (y = baseDepth)
    // Each entry: [y, radialInset, normalRadialWeight, normalYWeight]
    const vProfile: Array<[number, number, number, number]> = [
      [0.0, 0.0, 1.0, 0.0],
      [baseDepth * 0.5, 0.0, 1.0, 0.0],
      [baseDepth - bevelR, 0.0, 1.0, 0.0],
      [baseDepth - bevelR * 0.4, bevelR * 0.25, 0.8, 0.6],
      [baseDepth, bevelR, 0.0, 1.0],
      [baseDepth, bevelR + 0.024, -0.15, 0.99],
    ]

    const rows = vProfile.length
    const cols = pts.length

    const positions: number[] = []
    const normals: number[] = []
    const uvs: number[] = []
    const indices: number[] = []

    for (let r = 0; r < rows; r++) {
      const [py, inset, nRad, nUp] = vProfile[r]
      const vCoord = r / (rows - 1)
      for (let c = 0; c < cols; c++) {
        const [px, pz, nx, nz] = pts[c]
        const uCoord = c / (cols - 1)

        positions.push(px - nx * inset, py, pz - nz * inset)
        normals.push(nx * nRad, nUp, nz * nRad)
        uvs.push(uCoord, vCoord)
      }
    }

    // Counter-clockwise outward-facing winding order
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c
        const b = a + 1
        const d = (r + 1) * cols + c
        const e = d + 1
        indices.push(a, d, b)
        indices.push(b, d, e)
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geo.setIndex(indices)
    return geo
  }, [])

  useEffect(() => {
    return () => {
      geometry.dispose()
    }
  }, [geometry])

  useEffect(() => {
    if (matRef.current) {
      injectJellyIntoMaterial(matRef.current, jellyUniforms, 'resin-transmission-v4')
      matRef.current.needsUpdate = true
    }
  }, [jellyUniforms])

  const attenuationColor = useMemo(() => {
    const c = new THREE.Color(waterColor)
    return c.lerp(new THREE.Color('#19dfd6'), 0.35)
  }, [waterColor])

  const surfaceTint = useMemo(() => {
    const c = new THREE.Color(waterColor)
    return c.lerp(new THREE.Color('#bafaf5'), 0.48)
  }, [waterColor])

  useFrame(() => {
    if (meshRef.current) {
      const baseDepth = DEFAULT_WATER_LEVEL - BASE_SAND_HEIGHT
      const currentDepth = Math.max(0.4, waterLevel - BASE_SAND_HEIGHT)
      meshRef.current.scale.set(1, currentDepth / baseDepth, 1)
      meshRef.current.position.set(0, BASE_SAND_HEIGHT, 0)
    }
  })

  return (
    <mesh ref={meshRef} geometry={geometry} renderOrder={2}>
      <MeshTransmissionMaterial
        ref={matRef as any}
        backside={false}
        samples={2}
        resolution={192}
        transmission={0.95}
        roughness={0.02}
        ior={1.36}
        thickness={0.85}
        chromaticAberration={0.012}
        anisotropy={0.0}
        distortion={0.0}
        distortionScale={0.0}
        temporalDistortion={0.0}
        clearcoat={1.0}
        clearcoatRoughness={0.02}
        attenuationDistance={1.85}
        attenuationColor={attenuationColor}
        color={surfaceTint}
      />
    </mesh>
  )
}
