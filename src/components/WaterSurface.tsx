import { useMemo, useRef, useEffect } from 'react'
import * as THREE from 'three'
import { useFrame, ThreeEvent } from '@react-three/fiber'
import {
  BLOCK_HALF_SIZE,
  BLOCK_CORNER_RADIUS,
  mapSquareToRoundedBox,
} from '../utils/dioramaData'
import { JELLY_VERTEX_PARS, JellyUniforms } from '../utils/jellyShader'

export interface WaterSurfaceProps {
  waterLevel: number
  waterColor: string
  waveHeight: number
  sunDirection: THREE.Vector3
  terrainMap: THREE.DataTexture
  getHeightfieldTexture: () => THREE.Texture
  injectPointerUv: (uv: THREE.Vector2, velocityBoost?: number) => void
  triggerSplash: (uv: THREE.Vector2, strength?: number) => void
  jellyUniforms: JellyUniforms
  segments?: number
}

const WATER_VERTEX_SHADER = /* glsl */ `
${JELLY_VERTEX_PARS}

uniform float uTime;
uniform float uWaterLevel;
uniform float uWaveHeight;
uniform sampler2D uHeightfield;
uniform sampler2D uTerrainMap;

varying vec3 vWorldPos;
varying vec3 vLocalPos;
varying vec2 vSimUv;
varying float vWaveElevation;

// Smooth multi-directional swell so the jelly water surface gently breathes
float computeAmbientSwell(vec2 xz, float time) {
  float w1 = sin(xz.x * 2.6 + xz.y * 1.9 - time * 1.65) * 0.015;
  float w2 = cos(xz.x * 4.1 - xz.y * 3.3 + time * 2.15) * 0.009;
  float w3 = sin((xz.x + xz.y) * 5.8 - time * 2.8) * 0.005;
  return w1 + w2 + w3;
}

void main() {
  vSimUv = position.xz / ${(BLOCK_HALF_SIZE * 2.0).toFixed(2)} + 0.5;

  vec4 hf = texture2D(uHeightfield, vSimUv);
  vec4 tData = texture2D(uTerrainMap, vSimUv);

  float obstacleH = tData.g;
  float boxSdf = tData.a;
  float waterDepth = max(0.0, uWaterLevel - obstacleH);

  // Taper wave vertical displacement near outer resin rim so edge meets the beveled wall cleanly,
  // while keeping full bouncy wave & ripple displacement across the interior and beach swash
  float rimTaper = smoothstep(0.0, -0.07, boxSdf);
  float shoreSwash = sin(uTime * 2.3 - waterDepth * 15.0) * 0.011 * smoothstep(0.32, 0.02, waterDepth);

  float swell = computeAmbientSwell(position.xz, uTime) * uWaveHeight * smoothstep(0.02, 0.25, waterDepth);
  float gpuWave = hf.r * (0.44 + 0.26 * uWaveHeight);

  float totalElevation = (swell + gpuWave + shoreSwash * uWaveHeight) * rimTaper;
  vWaveElevation = totalElevation;

  vec3 displaced = vec3(position.x, uWaterLevel + totalElevation, position.z);
  vLocalPos = displaced;

  vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
  vWorldPos = worldPosition.xyz;

  // Apply shared spring jelly deformation
  worldPosition.xyz = applyJellyDeformation(worldPosition.xyz);

  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`

const WATER_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uWaterLevel;
uniform float uWaveHeight;
uniform vec3 uWaterColor;
uniform vec3 uSunDirection;
uniform sampler2D uHeightfield;
uniform sampler2D uTerrainMap;

varying vec3 vWorldPos;
varying vec3 vLocalPos;
varying vec2 vSimUv;
varying float vWaveElevation;

// Fast 2D hash & value noise for lacy sea foam and micro-ripples
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i + vec2(0.0, 0.0)), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm2(vec2 p) {
  mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
  float v = 0.65 * noise2(p);
  p = rot * p * 2.05;
  v += 0.35 * noise2(p);
  return v;
}

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

// Directional ocean wave surface height for crisp glossy wavelets
float wavePattern(vec2 xz, float time) {
  vec2 d1 = vec2(0.82, 0.57);
  vec2 d2 = vec2(0.55, -0.83);
  float swell =
    sin(dot(xz, d1) * 6.5 - time * 2.1) * 0.35 +
    cos(dot(xz, d2) * 9.2 - time * 2.6) * 0.25 +
    sin((xz.x - xz.y) * 14.5 + time * 3.1) * 0.14;
  float detail = fbm2(xz * 3.6 + vec2(time * 0.34, -time * 0.26));
  return swell * 0.45 + detail;
}

void main() {
  vec4 tData = texture2D(uTerrainMap, vSimUv);
  float terrainH = tData.r;
  float obstacleH = tData.g;
  float isBeach = tData.b;
  float boxSdf = tData.a;

  // Dynamic water surface height at this pixel
  float surfaceY = uWaterLevel + vWaveElevation;
  float depth = surfaceY - obstacleH;

  // Discard pixels that are inside the solid dry island cliff or emerging rock core
  if (depth < -0.015) {
    discard;
  }

  vec4 hf = texture2D(uHeightfield, vSimUv);
  vec2 gpuGrad = hf.ba;

  // 1. Construct Glossy Jelly + Ocean Wave Normal
  // Open ocean on the right/back-right has crisper wind wavelets, sheltered bay is silkier
  float openOceanFactor = smoothstep(-0.6, 1.8, vLocalPos.x - vLocalPos.z * 0.35);
  float waveScale = mix(0.65, 1.35, openOceanFactor) * (0.45 + 0.55 * uWaveHeight);

  float eps = 0.035;
  float h0 = wavePattern(vLocalPos.xz, uTime);
  float hx = wavePattern(vLocalPos.xz + vec2(eps, 0.0), uTime) - h0;
  float hz = wavePattern(vLocalPos.xz + vec2(0.0, eps), uTime) - h0;

  vec2 totalSlope = gpuGrad * 6.8 + vec2(hx, hz) * 2.25 * waveScale;
  vec3 N = normalize(vec3(-totalSlope.x, 1.0, -totalSlope.y));

  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uSunDirection);
  vec3 H = normalize(L + V);

  // 2. Refracted Underwater View (Sandy Seabed + Reef Patches + Caustics Web)
  vec2 refractOffset = N.xz * clamp(depth * 0.14, 0.01, 0.16);
  vec2 refractedUv = clamp(vSimUv + refractOffset * 0.14, 0.002, 0.998);
  vec4 refractedTerrain = texture2D(uTerrainMap, refractedUv);
  float refractedDepth = max(0.0, surfaceY - refractedTerrain.r);

  vec2 refractedXZ = vLocalPos.xz + refractOffset * 1.1;

  // Seabed sand & dark coral reef patches visible through the crystal turquoise water
  vec3 seabedSand = vec3(0.95, 0.89, 0.75);
  float reefNoise = fbm2(refractedXZ * 1.75 + 2.1);
  float reefMask = smoothstep(0.48, 0.67, reefNoise) * smoothstep(0.22, 0.58, refractedDepth);
  vec3 reefDark = vec3(0.05, 0.25, 0.28);
  vec3 floorColor = mix(seabedSand, reefDark, reefMask * 0.68);

  // Crisp Voronoi Caustics dancing on the refracted seabed (strongest in front & shallow-mid turquoise zone!)
  float c1 = causticLayer(refractedXZ * 3.45 + vec2(uTime * 0.08, -uTime * 0.06) + gpuGrad * 2.4, uTime);
  float c2 = causticLayer(refractedXZ * 4.70 - vec2(uTime * 0.05, uTime * 0.09) + 5.2, uTime * 1.15);
  float caustics = (max(c1, c2 * 0.85) + c1 * c2 * 1.6) * smoothstep(0.02, 0.15, refractedDepth) * smoothstep(1.45, 0.25, refractedDepth);

  // Boost caustics visibility in the foreground turquoise lagoon (matching reference photo!)
  float foregroundBoost = 1.0 + 0.52 * smoothstep(-0.5, 2.2, vLocalPos.x + vLocalPos.z);
  floorColor += vec3(0.75, 1.0, 0.96) * caustics * 0.78 * foregroundBoost;

  // 3. Shallow-to-Deep Turquoise & Cerulean Water Color Mixing ("由浅到深的青绿色水色")
  // - Shallow near beach: crystal aqua (#6ef2ea)
  // - Mid lagoon: vibrant tropical turquoise (uWaterColor, e.g. #12b8b2)
  // - Deep right ocean: rich deep teal-blue (#053c5e)
  vec3 shallowAqua = mix(vec3(0.50, 0.96, 0.91), uWaterColor, 0.25);
  vec3 midTurquoise = uWaterColor;
  vec3 deepOceanBlue = mix(uWaterColor * vec3(0.07, 0.34, 0.56), vec3(0.02, 0.19, 0.35), 0.58);

  float depthFactor = clamp(refractedDepth / 1.15, 0.0, 1.0);
  float deepCornerFactor = smoothstep(-0.15, 2.25, vLocalPos.x - vLocalPos.z * 0.45);
  float combinedDeep = clamp(depthFactor * 0.65 + deepCornerFactor * 0.45, 0.0, 1.0);

  vec3 waterTint = mix(shallowAqua, midTurquoise, smoothstep(0.03, 0.42, combinedDeep));
  waterTint = mix(waterTint, deepOceanBlue, smoothstep(0.40, 0.95, combinedDeep));

  // Beer-Lambert optical transmission from seabed through water column
  float waterOpacity = 1.0 - exp(-refractedDepth * (1.35 + combinedDeep * 1.45));
  vec3 transmittedColor = mix(floorColor, waterTint * (0.78 + 0.22 * (1.0 - combinedDeep)), waterOpacity);

  // Add subsurface jelly luminescence on wave crests & mouse ripples
  float waveCrest = clamp(vWaveElevation * 15.0 + length(gpuGrad) * 6.5, 0.0, 1.0);
  transmittedColor += vec3(0.32, 0.90, 0.87) * waveCrest * 0.18;

  // 4. Studio Sky Reflection & Dual-Lobe Jelly Specular Highlights
  float ndv = max(0.001, dot(N, V));
  float fresnel = 0.04 + 0.96 * pow(1.0 - ndv, 3.8);

  vec3 R = reflect(-V, N);
  float skyGrad = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 skyReflect = mix(vec3(0.74, 0.89, 0.92), vec3(0.99, 0.96, 0.91), skyGrad);

  // Crisp sun specular + glossy broad jelly clearcoat highlight
  float specTight = pow(max(0.0, dot(N, H)), 190.0) * 1.85;
  float specJelly = pow(max(0.0, dot(N, H)), 26.0) * 0.34;
  vec3 specular = vec3(1.0, 0.98, 0.93) * (specTight + specJelly);

  vec3 surfaceColor = mix(transmittedColor, skyReflect, fresnel * 0.62) + specular;

  // 5. Multi-Layered Shoreline & Coastal Rock Foam ("岸边泡沫")
  float foamNoise1 = fbm2(vLocalPos.xz * 8.5 + vec2(uTime * 0.32, -uTime * 0.24));
  float foamNoise2 = fbm2(vLocalPos.xz * 18.0 - vec2(uTime * 0.42, uTime * 0.32));
  float lacyBubbles = smoothstep(0.35, 0.68, foamNoise1 * 0.6 + foamNoise2 * 0.4);

  // A. Beach swash waves (2-3 gentle white lacy surf lines lapping the curved sandy beach)
  float swashPhase = depth * 28.0 + uTime * 2.3 + foamNoise1 * 3.0;
  float swashRings = pow(max(0.0, cos(swashPhase)), 7.0) * smoothstep(0.24, 0.01, depth) * smoothstep(-0.01, 0.018, depth);
  float waterEdgeFoam = smoothstep(0.048, -0.005, depth);
  float beachFoam = (waterEdgeFoam * (0.62 + 0.38 * lacyBubbles) + swashRings * (0.42 + 0.58 * lacyBubbles)) * (0.35 + 0.65 * isBeach);

  // B. Tight lacy foam around emerging coastal rocks & rocky headlands (no solid circles!)
  float rockyShoreMask = (1.0 - isBeach * 0.75) * smoothstep(0.14, 0.0, depth);
  float rockWaveRing = sin(depth * 38.0 + uTime * 3.0 + foamNoise1 * 4.2) * 0.5 + 0.5;
  float rockFoam = rockyShoreMask * smoothstep(0.42, 0.76, foamNoise1 * 0.72 + rockWaveRing * 0.42);
  rockFoam += smoothstep(0.032, -0.004, depth) * (1.0 - isBeach) * (0.55 + 0.45 * lacyBubbles);

  // C. Subtle glossy resin meniscus highlight around the outer rounded-square rim
  float outerMeniscus = smoothstep(-0.09, -0.004, boxSdf) * (0.32 + 0.68 * foamNoise1);

  float totalFoam = clamp(max(beachFoam, rockFoam) + outerMeniscus * 0.35, 0.0, 1.0);
  vec3 foamColor = vec3(0.98, 0.99, 1.0);

  surfaceColor = mix(surfaceColor, foamColor, totalFoam);

  // Soft alpha feather at the swash tip onto dry sand, PLUS optical translucency so the 3D
  // Seabed and submerged Rocks meshes underneath are clearly visible through the water!
  float shoreFeather = smoothstep(-0.015, 0.012, depth);
  float opticalAlpha = mix(0.46, 0.84, combinedDeep);
  opticalAlpha = max(opticalAlpha, clamp(totalFoam * 0.95 + fresnel * 0.65 + (specTight + specJelly) * 0.7, 0.0, 1.0));

  gl_FragColor = vec4(surfaceColor, shoreFeather * opticalAlpha);
}
`

export function WaterSurface({
  waterLevel,
  waterColor,
  waveHeight,
  sunDirection,
  terrainMap,
  getHeightfieldTexture,
  injectPointerUv,
  triggerSplash,
  jellyUniforms,
  segments = 160,
}: WaterSurfaceProps) {
  const matRef = useRef<THREE.ShaderMaterial>(null)
  const lastUv = useRef<THREE.Vector2 | null>(null)

  // Construct exact rounded-square grid geometry so the water surface matches the ResinBlock perimeter
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(1, 1, segments, segments)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position as THREE.BufferAttribute

    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) * 2.0
      const v = pos.getZ(i) * 2.0
      const [rx, rz] = mapSquareToRoundedBox(
        u,
        v,
        BLOCK_HALF_SIZE - 0.018,
        BLOCK_CORNER_RADIUS - 0.015
      )
      pos.setXYZ(i, rx, 0, rz)
    }

    geo.computeVertexNormals()
    return geo
  }, [segments])

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uWaterLevel: { value: waterLevel },
      uWaveHeight: { value: waveHeight },
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
      geometry.dispose()
    }
  }, [geometry])

  useFrame((state) => {
    if (matRef.current) {
      matRef.current.uniforms.uTime.value = state.clock.elapsedTime
      matRef.current.uniforms.uWaterLevel.value = waterLevel
      matRef.current.uniforms.uWaveHeight.value = waveHeight
      matRef.current.uniforms.uWaterColor.value.set(waterColor)
      matRef.current.uniforms.uSunDirection.value.copy(sunDirection)
      matRef.current.uniforms.uHeightfield.value = getHeightfieldTexture()
    }
  })

  const pointToSimUv = (pt: THREE.Vector3): THREE.Vector2 => {
    const u = pt.x / (BLOCK_HALF_SIZE * 2.0) + 0.5
    const v = pt.z / (BLOCK_HALF_SIZE * 2.0) + 0.5
    return new THREE.Vector2(
      Math.max(0.01, Math.min(0.99, u)),
      Math.max(0.01, Math.min(0.99, v))
    )
  }

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const uv = pointToSimUv(e.point)
    let boost = 1.0
    if (lastUv.current) {
      const dist = uv.distanceTo(lastUv.current)
      boost = Math.max(0.75, Math.min(2.4, dist * 38.0))
    }
    lastUv.current = uv
    injectPointerUv(uv, boost)
  }

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const uv = pointToSimUv(e.point)
    lastUv.current = uv
    triggerSplash(uv, 1.35)
  }

  return (
    <mesh
      geometry={geometry}
      onPointerMove={handlePointerMove}
      onPointerDown={handlePointerDown}
      renderOrder={3}
    >
      <shaderMaterial
        ref={matRef}
        vertexShader={WATER_VERTEX_SHADER}
        fragmentShader={WATER_FRAGMENT_SHADER}
        uniforms={uniforms}
        transparent={true}
        depthWrite={true}
      />
    </mesh>
  )
}
