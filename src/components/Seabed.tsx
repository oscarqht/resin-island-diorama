import { useMemo, useRef, useEffect } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import {
  BLOCK_HALF_SIZE,
  BLOCK_CORNER_RADIUS,
  BASE_SAND_HEIGHT,
  mapSquareToRoundedBox,
  sampleDioramaTerrain,
} from '../utils/dioramaData'
import { JELLY_VERTEX_PARS, JellyUniforms, injectJellyIntoMaterial } from '../utils/jellyShader'

export interface SeabedProps {
  waterLevel: number
  waterColor: string
  sunDirection: THREE.Vector3
  terrainMap: THREE.DataTexture
  getHeightfieldTexture: () => THREE.Texture
  jellyUniforms: JellyUniforms
  segments?: number
}

const SEABED_VERTEX_SHADER = /* glsl */ `
${JELLY_VERTEX_PARS}

varying vec3 vWorldPos;
varying vec3 vNormalDir;
varying vec2 vSimUv;

void main() {
  vSimUv = position.xz / ${(BLOCK_HALF_SIZE * 2.0).toFixed(2)} + 0.5;
  vNormalDir = normalize(normalMatrix * normal);

  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPosition.xyz;

  worldPosition.xyz = applyJellyDeformation(worldPosition.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`

const SEABED_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uWaterLevel;
uniform vec3 uWaterColor;
uniform vec3 uSunDirection;
uniform sampler2D uHeightfield;
uniform sampler2D uTerrainMap;

varying vec3 vWorldPos;
varying vec3 vNormalDir;
varying vec2 vSimUv;

// Zero-loop 3-wave optical interference caustics (curvy lens filaments at 10x speed of Voronoi)
float causticLayer(vec2 uv, float time) {
  vec2 p = uv * 0.92;
  p += 0.24 * vec2(
    sin(p.y * 1.9 + time * 1.15) + cos(p.x * 1.5 - time * 0.85),
    cos(p.x * 2.1 - time * 1.05) + sin(p.y * 1.7 + time * 0.95)
  );
  float w1 = abs(sin(p.x * 2.6 + sin(p.y * 2.1 + time * 0.9)));
  vec2 p2 = mat2(0.5, -0.866, 0.866, 0.5) * p;
  float w2 = abs(sin(p2.x * 2.6 + cos(p2.y * 2.1 - time * 1.05)));
  vec2 p3 = mat2(-0.5, -0.866, 0.866, -0.5) * p;
  float w3 = abs(sin(p3.x * 2.6 + sin(p3.y * 2.1 + time * 0.8)));
  float web = 1.0 - min(w1, min(w2, w3)) * 1.35;
  return pow(clamp(web, 0.0, 1.0), 3.2);
}

float computeCaustics(vec2 xz, vec3 sunDir, float time, vec2 waveGrad) {
  vec2 refractedXz = xz - sunDir.xz / max(0.35, sunDir.y) * 0.28 + waveGrad * 2.6;

  float c1 = causticLayer(refractedXz * 3.45 + vec2(time * 0.07, -time * 0.05), time);
  float c2 = causticLayer(refractedXz * 4.65 - vec2(time * 0.05, time * 0.08) + 4.7, time * 1.1);
  float web = max(c1, c2 * 0.85) + c1 * c2 * 1.5;

  float rippleFocus = clamp((abs(waveGrad.x) + abs(waveGrad.y)) * 18.0, 0.0, 1.2);
  return web + rippleFocus * 0.7;
}

void main() {
  vec4 hf = texture2D(uHeightfield, vSimUv);
  float depth = max(0.0, (uWaterLevel + hf.r * 0.4) - vWorldPos.y);

  // Warm cream-gold sand with subtle wave-sculpted ripples
  float ripplePattern = sin(length(vWorldPos.xz - vec2(-0.4, 0.0)) * 20.0 + sin(vWorldPos.x * 5.0) * 1.4) * 0.5 + 0.5;
  vec3 drySand = vec3(0.96, 0.90, 0.77);
  vec3 wetSand = vec3(0.89, 0.81, 0.65);
  vec3 sandAlbedo = mix(drySand, wetSand, smoothstep(0.0, 0.35, depth));
  sandAlbedo *= 0.96 + 0.04 * ripplePattern;

  // Subtle dark coral/moss patches in mid-to-deep seabed
  float patchNoise = sin(vWorldPos.x * 2.9 + cos(vWorldPos.z * 3.2)) * cos(vWorldPos.z * 2.5 - vWorldPos.x * 1.8);
  float reefPatch = smoothstep(0.42, 0.82, patchNoise) * smoothstep(0.28, 0.75, depth);
  sandAlbedo = mix(sandAlbedo, vec3(0.10, 0.28, 0.25), reefPatch * 0.58);

  vec3 N = normalize(vNormalDir);
  vec3 L = normalize(uSunDirection);
  float ndl = max(0.25, dot(N, L));

  // Caustics strongest in the foreground & shallow-to-mid turquoise lagoon, fading in the deep right corner
  float deepRightCorner = smoothstep(0.0, 2.5, vWorldPos.x - vWorldPos.z * 0.45);
  float underwaterMask =
    smoothstep(0.01, 0.10, depth) *
    smoothstep(1.55, 0.22, depth) *
    (1.0 - deepRightCorner * 0.65);

  float caustics = computeCaustics(vWorldPos.xz, L, uTime, hf.ba) * underwaterMask;

  // Shallow-to-deep turquoise water column tint
  vec3 shallowTint = mix(vec3(0.58, 0.96, 0.92), uWaterColor, 0.28);
  vec3 midTint = uWaterColor;
  vec3 deepTint = mix(uWaterColor * vec3(0.10, 0.38, 0.56), vec3(0.03, 0.22, 0.36), 0.55);

  float dNorm = clamp(depth / 1.15 + deepRightCorner * 0.32, 0.0, 1.0);
  vec3 waterColumnTint = mix(shallowTint, midTint, smoothstep(0.04, 0.45, dNorm));
  waterColumnTint = mix(waterColumnTint, deepTint, smoothstep(0.42, 0.98, dNorm));

  vec3 litSand = sandAlbedo * (0.38 + 0.66 * ndl);
  litSand += vec3(0.82, 1.0, 0.96) * caustics * 0.76;

  float absorption = 1.0 - exp(-depth * 0.95);
  vec3 finalColor = mix(
    litSand,
    litSand * waterColumnTint * 1.25 + waterColumnTint * 0.16,
    absorption * (0.62 + 0.28 * deepRightCorner)
  );

  gl_FragColor = vec4(finalColor, 1.0);
}
`

export function Seabed({
  waterLevel,
  waterColor,
  sunDirection,
  terrainMap,
  getHeightfieldTexture,
  jellyUniforms,
  segments = 72,
}: SeabedProps) {
  const matRef = useRef<THREE.ShaderMaterial>(null)

  const seabedGeo = useMemo(() => {
    const geo = new THREE.PlaneGeometry(1, 1, segments, segments)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position as THREE.BufferAttribute

    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) * 2.0
      const v = pos.getZ(i) * 2.0
      const [rx, rz] = mapSquareToRoundedBox(
        u,
        v,
        BLOCK_HALF_SIZE - 0.015,
        BLOCK_CORNER_RADIUS - 0.01
      )
      const sample = sampleDioramaTerrain(rx, rz)
      pos.setXYZ(i, rx, sample.seabedHeight, rz)
    }

    geo.computeVertexNormals()
    return geo
  }, [segments])

  const basePlateGeo = useMemo(() => {
    const shape = new THREE.Shape()
    const hs = BLOCK_HALF_SIZE
    const r = BLOCK_CORNER_RADIUS

    shape.moveTo(-hs + r, -hs)
    shape.lineTo(hs - r, -hs)
    shape.absarc(hs - r, -hs + r, r, -Math.PI / 2, 0, false)
    shape.lineTo(hs, hs - r)
    shape.absarc(hs - r, hs - r, r, 0, Math.PI / 2, false)
    shape.lineTo(-hs + r, hs)
    shape.absarc(-hs + r, hs - r, r, Math.PI / 2, Math.PI, false)
    shape.lineTo(-hs, -hs + r)
    shape.absarc(-hs + r, -hs + r, r, Math.PI, Math.PI * 1.5, false)

    const extrude = new THREE.ExtrudeGeometry(shape, {
      depth: BASE_SAND_HEIGHT,
      bevelEnabled: true,
      bevelSegments: 3,
      steps: 1,
      bevelSize: 0.018,
      bevelThickness: 0.018,
      curveSegments: 32,
    })
    extrude.rotateX(-Math.PI / 2)
    extrude.translate(0, 0.018, 0)
    return extrude
  }, [])

  const baseMaterial = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#dfd1b5'),
      roughness: 0.78,
      metalness: 0.02,
    })
    injectJellyIntoMaterial(mat, jellyUniforms, 'seabed-base-rim')
    return mat
  }, [jellyUniforms])

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uWaterLevel: { value: waterLevel },
      uWaterColor: { value: new THREE.Color(waterColor) },
      uSunDirection: { value: sunDirection.clone() },
      uHeightfield: { value: terrainMap },
      uTerrainMap: { value: terrainMap },
      uJellyOffset: jellyUniforms.uJellyOffset,
      uJellyVelocity: jellyUniforms.uJellyVelocity,
      uJellyTime: jellyUniforms.uJellyTime,
      uJellyStrength: jellyUniforms.uJellyStrength,
    }),
    [terrainMap, jellyUniforms]
  )

  useEffect(() => {
    return () => {
      seabedGeo.dispose()
      basePlateGeo.dispose()
      baseMaterial.dispose()
    }
  }, [seabedGeo, basePlateGeo, baseMaterial])

  useFrame((state) => {
    if (matRef.current) {
      matRef.current.uniforms.uTime.value = state.clock.elapsedTime
      matRef.current.uniforms.uWaterLevel.value = waterLevel
      matRef.current.uniforms.uWaterColor.value.set(waterColor)
      matRef.current.uniforms.uSunDirection.value.copy(sunDirection)
      matRef.current.uniforms.uHeightfield.value = getHeightfieldTexture()
    }
  })

  return (
    <group>
      <mesh geometry={seabedGeo} receiveShadow>
        <shaderMaterial
          ref={matRef}
          vertexShader={SEABED_VERTEX_SHADER}
          fragmentShader={SEABED_FRAGMENT_SHADER}
          uniforms={uniforms}
        />
      </mesh>
      <mesh geometry={basePlateGeo} material={baseMaterial} castShadow receiveShadow />
    </group>
  )
}
