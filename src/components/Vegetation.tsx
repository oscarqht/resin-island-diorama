import { useMemo, useRef, useLayoutEffect, useEffect } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { VegetationInstanceData, fbm2D } from '../utils/dioramaData'
import { JELLY_VERTEX_PARS, JellyUniforms } from '../utils/jellyShader'

export interface VegetationProps {
  instances: VegetationInstanceData[]
  sunDirection?: THREE.Vector3
  jellyUniforms: JellyUniforms
}

function createCanopyClusterGeometry(): THREE.BufferGeometry {
  const lobes: Array<{ offset: [number, number, number]; scale: [number, number, number] }> = [
    { offset: [0, 0.25, 0], scale: [0.68, 0.56, 0.68] },
    { offset: [0.34, 0.14, 0.20], scale: [0.52, 0.44, 0.52] },
    { offset: [-0.32, 0.15, 0.18], scale: [0.50, 0.44, 0.48] },
    { offset: [0.04, 0.14, -0.34], scale: [0.52, 0.42, 0.50] },
  ]

  const baseSphere = new THREE.IcosahedronGeometry(1, 1)
  const basePos = baseSphere.attributes.position as THREE.BufferAttribute
  const baseNorm = baseSphere.attributes.normal as THREE.BufferAttribute
  const baseIndex = baseSphere.index

  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const indices: number[] = []

  let vertexOffset = 0

  lobes.forEach((lobe, lobeIdx) => {
    const [ox, oy, oz] = lobe.offset
    const [sx, sy, sz] = lobe.scale

    for (let i = 0; i < basePos.count; i++) {
      const vx = basePos.getX(i)
      const vy = basePos.getY(i)
      const vz = basePos.getZ(i)

      const n = fbm2D(vx * 3.1 + lobeIdx * 3.7, vz * 3.1 - vy * 2.3, 2)
      const disp = 1.0 + n * 0.28

      const px = ox + vx * sx * disp
      const py = Math.max(-0.08, oy + vy * sy * disp)
      const pz = oz + vz * sz * disp

      positions.push(px, py, pz)
      normals.push(baseNorm.getX(i), baseNorm.getY(i), baseNorm.getZ(i))

      // Store local canopy AO in R, lobe variation in G, micro-bump in B
      const ao = Math.max(0.15, Math.min(1.0, (py + 0.08) / 0.78))
      colors.push(ao, (lobeIdx % 3) * 0.33, n * 0.5 + 0.5)
    }

    if (baseIndex) {
      for (let j = 0; j < baseIndex.count; j++) {
        indices.push(baseIndex.getX(j) + vertexOffset)
      }
    } else {
      for (let j = 0; j < basePos.count; j++) {
        indices.push(j + vertexOffset)
      }
    }

    vertexOffset += basePos.count
  })

  baseSphere.dispose()

  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  merged.setAttribute('aVertexMeta', new THREE.Float32BufferAttribute(colors, 3))
  merged.setIndex(indices)
  merged.computeVertexNormals()
  return merged
}

const VEGETATION_VERTEX_SHADER = /* glsl */ `
${JELLY_VERTEX_PARS}

attribute vec3 aVertexMeta;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vVertexMeta;
varying vec3 vInstanceColor;

void main() {
  vVertexMeta = aVertexMeta;
  #ifdef USE_INSTANCING_COLOR
    vInstanceColor = instanceColor;
  #else
    vInstanceColor = vec3(0.18, 0.30, 0.09);
  #endif

  vec4 instPos = instanceMatrix * vec4(position, 1.0);
  vec4 worldPosition = modelMatrix * instPos;

  vWorldPos = worldPosition.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);

  worldPosition.xyz = applyJellyDeformation(worldPosition.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`

const VEGETATION_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec3 uSunDirection;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vVertexMeta;
varying vec3 vInstanceColor;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(hash31(i + vec3(0, 0, 0)), hash31(i + vec3(1, 0, 0)), f.x),
      mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x),
      f.y
    ),
    mix(
      mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x),
      mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x),
      f.y
    ),
    f.z
  );
}

void main() {
  // Single fast 3D noise + analytical micro-leaf lattice for crisp bushy texture
  float leaf1 = noise3(vWorldPos * 22.0);
  float leaf2 = sin(vWorldPos.x * 46.0 + vWorldPos.y * 32.0) * cos(vWorldPos.z * 46.0 - vWorldPos.y * 28.0) * 0.5 + 0.5;
  float leafCluster = leaf1 * 0.7 + leaf2 * 0.3;

  vec3 N = normalize(vWorldNormal);
  vec3 L = normalize(uSunDirection);
  float ndl = max(0.0, dot(N, L));

  float ao = vVertexMeta.r;
  float creviceAO = smoothstep(0.22, 0.78, ao * 0.72 + leafCluster * 0.46);

  vec3 shadowGreen = vec3(0.03, 0.08, 0.02);
  vec3 midGreen = vInstanceColor * (0.78 + 0.38 * leaf1);
  vec3 sunlitTip = vec3(0.32, 0.44, 0.13);

  vec3 baseFoliage = mix(shadowGreen, midGreen, creviceAO);
  float tipMask = smoothstep(0.48, 0.92, ndl * ao * (0.55 + 0.65 * leafCluster));
  baseFoliage = mix(baseFoliage, sunlitTip, tipMask * 0.58);

  float diffuse = 0.24 + 0.76 * ndl;
  vec3 finalColor = baseFoliage * diffuse * (0.38 + 0.68 * creviceAO);

  gl_FragColor = vec4(finalColor, 1.0);
}
`

export function Vegetation({ instances, sunDirection, jellyUniforms }: VegetationProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const matRef = useRef<THREE.ShaderMaterial>(null)

  const geometry = useMemo(() => createCanopyClusterGeometry(), [])

  const uniforms = useMemo(
    () => ({
      uSunDirection: {
        value: sunDirection ? sunDirection.clone() : new THREE.Vector3(0.5, 0.78, 0.38).normalize(),
      },
      uJellyOffset: jellyUniforms.uJellyOffset,
      uJellyVelocity: jellyUniforms.uJellyVelocity,
      uJellyTime: jellyUniforms.uJellyTime,
      uJellyStrength: jellyUniforms.uJellyStrength,
    }),
    [jellyUniforms]
  )

  useEffect(() => {
    return () => {
      geometry.dispose()
    }
  }, [geometry])

  useLayoutEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return

    const dummy = new THREE.Object3D()
    const color = new THREE.Color()

    instances.forEach((inst, i) => {
      dummy.position.set(inst.position[0], inst.position[1], inst.position[2])
      dummy.rotation.set(inst.rotation[0], inst.rotation[1], inst.rotation[2])
      dummy.scale.set(inst.scale[0], inst.scale[1], inst.scale[2])
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)

      color.setRGB(inst.colorTint[0], inst.colorTint[1], inst.colorTint[2])
      mesh.setColorAt(i, color)
    })

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [instances])

  useFrame(() => {
    if (matRef.current && sunDirection) {
      matRef.current.uniforms.uSunDirection.value.copy(sunDirection)
    }
  })

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, undefined, instances.length]}
    >
      <shaderMaterial
        ref={matRef}
        vertexShader={VEGETATION_VERTEX_SHADER}
        fragmentShader={VEGETATION_FRAGMENT_SHADER}
        uniforms={uniforms}
      />
    </instancedMesh>
  )
}
